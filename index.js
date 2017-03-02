var express = require('express');
var qs = require('querystring');
var firebase = require("firebase");
var request = require('request');
var levenshtein = require('fast-levenshtein');

// initialize app
var app = express();
app.set('port', (process.env.PORT || 5000));
app.use(express.static(__dirname + '/public'));


// Initialize Firebase
firebase.initializeApp({
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    databaseURL: process.env.FIREBASE_URL,
    storageBucket: process.env.FIREBASE_BUCKET,
    messagingSenderId: process.env.FIREBASE_SENDERID
});
var database = firebase.database();


// views is directory for all template files
app.set('views', __dirname + '/views');
app.set('view engine', 'ejs');


app.get('/', function (request, response) {
    response.render('pages/index');
});

// handle jeopardy slack outgoing webhook
app.post('/jeopardy', function (request, response) {

    var body = '';

    request.on('data', function (data) {
        body += data;

        // Too much POST data, kill the connection!
        // 1e6 === 1 * Math.pow(10, 6) === 1 * 1000000 ~~~ 1MB
        if (body.length > 1e6)
            request.connection.destroy();
    });

    request.on('end', function () {

        // use qs to parse response body POST params
        var post = qs.parse(body);

        // get text
        var post_text = post.text.replace(post.trigger_word, '').trim();

        // check outgoing token
        if (post.token != (process.env.OUTGOING_WEBHOOK_TOKEN)) {
            json_response_for_slack(response, 'Invalid Token')

        } else if (post_text.startsWith("start")) {
            respond_with_question(post, function (reply) {
                json_response_for_slack(response, reply);
            })

        } else if (post_text.startsWith("leaderboard")) {
            respond_with_leaderboard(post, function (reply) {
                json_response_for_slack(response, reply);
            })

        } else if (post_text.startsWith("help")) {
            json_response_for_slack(response,
                '"j start" to get a new question. You will have 30 seconds.\n'
                + '"j [your answer]" to answer the current question\n'
                + '"j leaderboard" to see the current leaderboard'
            );

        } else {
            process_answer(post, function (reply) {
                json_response_for_slack(response, reply);
            })
        }

    });

});

app.listen(app.get('port'), function () {
    console.log('Node app is running on port', app.get('port'));
});

// Puts together the json payload that needs to be sent back to Slack
function json_response_for_slack(response, reply) {

    var resp = {
        text: reply,
        link_names: 1
    };

    response.end(JSON.stringify(resp));

}

// ask a question
function respond_with_question(post, callback) {

    database.ref('jeopardy/status').once('value').then(function (snapshot) {

        // check state ready OR previous state is SECONDS_TO_ANSWER seconds away
        if ((snapshot.val().state == 'READY') || (Date.now() - snapshot.val().timestamp > process.env.SECONDS_TO_ANSWER * 1000)) {

            // set status
            database.ref('jeopardy/status').set({
                state: 'WAITING FOR ANSWER',
                timestamp: Date.now()
            });

            // get question
            get_a_question(function (question_data) {

                // build reply
                var reply = ("The category is " + question_data.category.title
                + " for " + question_data.value + ": " + question_data.question);

                // set current question status
                database.ref('jeopardy/current_question').set(question_data);

                // return
                callback(reply)

            })

        } else {

            callback("")

        }
    });

}

// get a question
function get_a_question(callback) {
    request('http://jservice.io/api/random?count=1', function (error, response, body) {

        if (!error && response.statusCode == 200) {

            // parse response
            var q_data = JSON.parse(body)[0];

            // check for bad question
            if (!q_data.question || !q_data.question.trim()) {
                get_a_question(callback)

            } else {
                // set defaults
                q_data.value = q_data.value || 200;
                q_data.expiration = Date.now() + process.env.SECONDS_TO_ANSWER * 1000;
                // strip HTML
                q_data.answer = q_data.answer
                    .replace(/\s+(&nbsp;|&)\s+/i, " and ")
                    .replace(/<(?:.|\n)*?>/gm, '')
                    .replace(/ *\([^)]*\) */g, "")
                    .replace(/["]+/g, '')
                    .trim();
                callback(q_data)
            }

        }

    })
}

// intake an answer
function process_answer(post, callback) {

    database.ref('jeopardy/status').once('value').then(function (snapshot) {

        // check state WAITING
        if ((snapshot.val().state == 'WAITING FOR ANSWER')) {

            // get current question
            database.ref('jeopardy/current_question').once('value').then(function (snapshot) {
                var question = snapshot.val();
                var current_answer = post.text.replace(post.trigger_word, '').trim();

                // check that the question has not been answered
                if (!question.answered) {

                    // check that the question has not expired
                    if (Date.now() > question.expiration) {

                        if (is_correct_answer(question.answer, current_answer)) {
                            callback(
                                "That is correct, " + post.user_name + ", but time's up! Remember, you have "
                                + process.env.SECONDS_TO_ANSWER + " seconds to answer."
                            )
                        } else {
                            callback(
                                "Time's up, " + post.user_name + "! Remember, you have "
                                + process.env.SECONDS_TO_ANSWER + " seconds to answer. The correct answer is "
                                + question.answer + "."
                            )
                        }
                    } else {

                        // get current user
                        database.ref('jeopardy/leaderboard/' + post.user_id).once('value').then(function (snapshot) {

                            var user_obj = (snapshot.val() || {
                                    user_name: post.user_name,
                                    score: 0,
                                    n_answers: 0,
                                    n_correct: 0
                                });

                            // update name and number of answers total
                            user_obj.user_name = post.user_name;
                            user_obj.n_answers = (user_obj.n_answers || 0) + 1;

                            // check that the question is correct
                            if (is_correct_answer(question.answer, current_answer)) {

                                // mark as answered
                                question.answered = true;
                                database.ref('jeopardy/current_question').set(question);

                                // update user score
                                user_obj.score += question.value;
                                user_obj.n_correct = (user_obj.n_correct || 0) + 1;

                                // update user
                                database.ref('jeopardy/leaderboard/' + post.user_id).set(user_obj);

                                // reset status
                                database.ref('jeopardy/status').set({
                                    state: 'READY',
                                    timestamp: Date.now()
                                });

                                // respond
                                callback(question.answer + " is the correct answer, " + post.user_name
                                    + ". Your total score is now " + user_obj.score);

                            } else {

                                // update user, respond with nothing
                                database.ref('jeopardy/leaderboard/' + post.user_id).set(user_obj);
                                callback("");

                            }

                        });

                    }

                } else {
                    callback("")
                }

            });

        } else {
            callback("")
        }
    });

}

// fuzzy match an answer
function is_correct_answer(official_answer, user_answer) {

    // lower both
    official_answer = sanitize_text(official_answer);
    user_answer = sanitize_text(user_answer);

    // take out additional filler words
    official_answer = sanitize_text(
        official_answer
            .replace(/[^\w\s]/i, "")
            .replace(/^(the|a|an) /i, "")
    );
    user_answer = sanitize_text(
        user_answer
            .replace(/\s+(&nbsp;|&)\s+/i, "")
            .replace(/[^\w\s]/i, "")
            .replace(/^(what|whats|where|wheres|who|whos) /i, "")
            .replace(/^(is|are|was|were) /, "")
            .replace(/^(the|a|an) /i, "")
            .replace(/\?+$/, "")
    );

    // lower both
    official_answer = sanitize_text(official_answer);
    user_answer = sanitize_text(user_answer);

    // get lev ratio
    var lev = levenshtein.get(official_answer, user_answer);
    var lev_ratio = lev / official_answer.length;

    // return whether it's similar enough
    return (lev_ratio < process.env.SIMILARITY_TOLERANCE);

}

// sanitize answers
function sanitize_text(text) {
    return text.trim().toLowerCase()
}

// leaderboard
function respond_with_leaderboard(post, callback) {

    database.ref('jeopardy/leaderboard').once('value').then(function (snapshot) {

        var data = snapshot.val();

        // extract users and scores
        var leaderboard = [];
        for (var uid in data){
            leaderboard.push(data[uid])
        }

        // sort
        leaderboard = leaderboard.sort(function(a, b){return a.score < b.score});

        var leaderboard_text = "";

        // format text
        for (var i=0; i<leaderboard.length; i++){
            leaderboard_text += leaderboard[i]['user_name'] + ": " + leaderboard[i]['score'] + "\n"
        }

        callback(leaderboard_text)

    });
}

