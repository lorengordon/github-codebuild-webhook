'use strict';

var AWS = require('aws-sdk');
var codebuild = new AWS.CodeBuild();
var crypto = require('crypto');
var ssm = new AWS.SSM();

var GitHubApi = require("github");
var github = new GitHubApi();
var PULL_ACTIONS = [
    "opened",
    "reopened",
    "synchronize"
];
var COMMENT_ACTIONS = [
    "created"
];

var ssmParams = {
  username: {
    Name: process.env.SSM_GITHUB_USERNAME,
    WithDecryption: true
  },
  accessToken: {
    Name: process.env.SSM_GITHUB_ACCESS_TOKEN,
    WithDecryption: true
  }
};

// get the region where this lambda is running
var region = process.env.AWS_DEFAULT_REGION;

// get the github webhook secret parameter name
var ssmToken = process.env.SSM_GITHUB_WEBHOOK_SECRET;

// get the github status context
var githubContext = process.env.GITHUB_STATUS_CONTEXT;

// get the desired buildable events, 'pr_state,pr_comment'
var buildEvents = getObjectDefault(process.env, "GITHUB_BUILD_EVENTS", "pr_state").split(",");

// get the authorized build users
var buildUsers = getObjectDefault(process.env, "GITHUB_BUILD_USERS", "");
buildUsers = buildUsers != "" ? buildUsers.split(",") : [];

// get the build comment
var buildComment = getObjectDefault(process.env, "GITHUB_BUILD_COMMENT", "");
buildComment = buildComment != "" ? buildComment : "go codebuild go";

// this function will be triggered by the github webhook
module.exports.start_build = (event, context, callback) => {
  console.log("REQUEST RECEIVED:\n" + JSON.stringify(event));

  verifyGithubEvent(event, ssmToken, function (err) {
    if (err) {
      console.log(err);
      return callback(err);
    }

    var response = {
      pull_request: {},
      build: {}
    };

    var buildOptions = {
      event: event,
      buildEvents: buildEvents,
      buildUsers: buildUsers,
      buildComment: buildComment,
      pullActions: PULL_ACTIONS,
      commentActions: COMMENT_ACTIONS
    };

    getPullRequest(buildOptions, function (err, pullRequest) {
      if (err) {
        console.log(err);
        callback(err);
      } else if (pullRequest.state != "open") {
        callback("Pull request is not open");
      } else {
        console.log("Cleared tests, this is a buildable event:", event)
        response.pull_request = pullRequest;
        var head = pullRequest.head;
        var base = pullRequest.base;
        var repo = base.repo;

        var params = {
          projectName: process.env.BUILD_PROJECT,
          sourceVersion: 'pr/' + pullRequest.number
        };

        var status = {
          owner: repo.owner.login,
          repo: repo.name,
          sha: head.sha,
          state: 'pending',
          context: githubContext,
          description: 'Setting up the build...'
        };

        setGithubAuth(github, ssm, ssmParams, function (err) {
          if (err) {
            console.log(err);
            callback(err);
          } else {
            // check that we can set a status before starting the build
            github.repos.createStatus(status).then(function(data) {
              console.log("Set setup status:", data)
              // start the codebuild  project
              codebuild.startBuild(params, function(err, data) {
                if (err) {
                  console.log(err, err.stack);
                  callback(err);
                } else {
                  // store the build data in the response
                  response.build = data.build;
                  console.log("Started CodeBuild job:", data)

                  // all is well, mark the commit as being 'in progress'
                  status.description = 'Build is running...'
                  status.target_url = 'https://' + region + '.console.aws.amazon.com/codebuild/home?region=' + region + '#/builds/' + data.build.id + '/view/new'
                  github.repos.createStatus(status).then(function(data){
                    // success
                    console.log("Set running status:", data)
                    callback(null, response);
                  }).catch(function(err) {
                    console.log(err);
                    callback(err);
                  });
                }
              });
            }).catch(function(err) {
              console.log("Github authentication failed");
              console.log(err, err.stack);
              callback(err);
            });
          }
        });
      }
    });
});
}

module.exports.check_build_status = (event, context, callback) => {
  var response = event;
  var params = {
    ids: [event.build.id]
  }
  codebuild.batchGetBuilds(params, function(err, data) {
    if (err) {
      console.log(err, err.stack);
      context.fail(err)
      callback(err);
    } else {
      response.build = data.builds[0]
      callback(null, response);
    }
  });
}

module.exports.build_done = (event, context, callback) => {
  // get the necessary variables for the github call
  var base = event.pull_request.base;
  var head = event.pull_request.head;
  var repo = base.repo;

  console.log('Found commit identifier: ' + head.sha);

  // map the codebuild status to github state
  var buildStatus = event.build.buildStatus;
  var state = '';
  switch(buildStatus) {
    case 'SUCCEEDED':
      state = 'success';
      break;
    case 'FAILED':
      state = 'failure';
      break;
    case 'FAULT':
    case 'STOPPED':
    case 'TIMED_OUT':
      state = 'error'
    default:
      state = 'pending'
  }
  console.log('Github state will be', state);

  setGithubAuth(github, ssm, ssmParams, function (err) {
    if (err) {
      console.log(err);
      callback(err);
    } else {
      github.repos.createStatus({
        owner: repo.owner.login,
        repo: repo.name,
        sha: head.sha,
        state: state,
        target_url: 'https://' + region + '.console.aws.amazon.com/codebuild/home?region=' + region + '#/builds/' + event.build.id + '/view/new',
        context: githubContext,
        description: 'Build ' + buildStatus + '...'
      }).catch(function(err){
        console.log(err);
        context.fail(data);
      });
    }
  });
}

function signRequestBody(key, body) {
  return `sha1=${crypto.createHmac('sha1', key).update(body, 'utf-8').digest('hex')}`;
}

function verifyGithubEvent(event, ssmToken, callback) {
  let errMsg;
  let calculatedSig;
  const headers = event.headers;
  const sig = headers['X-Hub-Signature'];
  const githubEvent = headers['X-GitHub-Event'];
  const id = headers['X-GitHub-Delivery'];

  ssm.getParameter({
    Name: ssmToken,
    WithDecryption: true
  }, function (err, token) {
    if (err) {
      return callback(err);
    }

    calculatedSig = signRequestBody(token.Parameter.Value, event.body);

    if (!sig) {
      errMsg = '[401] No X-Hub-Signature found on request';
      return callback(new Error(errMsg));
    }

    if (!githubEvent) {
      errMsg = '[422] No X-Github-Event found on request';
      return callback(new Error(errMsg));
    }

    if (!id) {
      errMsg = '[401] No X-Github-Delivery found on request';
      return callback(new Error(errMsg));
    }

    if (sig !== calculatedSig) {
      errMsg = '[401] X-Hub-Signature incorrect. Github webhook token doesn\'t match';
      return callback(new Error(errMsg));
    }

    return callback();
  });
}

function setGithubAuth(github, ssm, params, callback) {

  if (github.hasOwnProperty("auth")) {
    console.log("Github auth object already set");
    callback();
  } else {
    console.log("Setting up the Github auth object");

    var cred = {
      type: "basic"
    };

    ssm.getParameter(params.username, function (err, data) {
      if (err) callback(err);
      else {
        cred.username = data.Parameter.Value;
        ssm.getParameter(params.accessToken, function (err, data) {
          if (err) callback(err);
          else {
            cred.password = data.Parameter.Value;
            try {
              github.authenticate(cred);
            } catch (err) {
              callback(err);
            }
            callback();
          }
        });
      }
    });
  }
}

/*
    getPullRequest() tests the build event and returns pr data if the event is
    buildable.

    options = {
      event: {},
      buildEvents: [],
      buildUsers: [],
      buildComment: "",
      pullActions: [],
      commentActions: [],
    }
*/
function getPullRequest(options, callback) {
    if (isPullEvent(options)) {
      callback(null, options.event.pull_request);
    } else if (isIssueCommentEvent(options)) {
      getPullFromComment(options.event.issue, function (err, data) {
        if (err) callback(err);
        else callback(null, data);
      });
    } else callback("Event is not buildable");
}

function isPullEvent(options) {
    var isBuildable = (
        'pull_request' in options.event &&
        options.pullActions.indexOf(options.event.action) >= 0 &&
        options.buildEvents.indexOf('pr_state') >= 0
    );
    console.log("Test for buildable pull_request event:", isBuildable);
    return isBuildable;
}

function isIssueCommentEvent(options) {
    var isBuildable = (
        'comment' in options.event &&
        'issue' in options.event &&
        'pull_request' in options.event.issue &&
        options.commentActions.indexOf(options.event.action) >= 0 &&
        options.buildEvents.indexOf('pr_comment') >= 0 &&
        options.buildComment.toLowerCase() === options.event.comment.body.toLowerCase()
    );
    if (options.buildUsers.length > 0) {
        isBuildable = isBuildable && options.buildUsers.indexOf(options.event.comment.user.login) >= 0
    }
    console.log("Test for buildable issue_comment event:", isBuildable);
    return isBuildable;
}

function getPullFromComment(issue, callback) {
    setGithubAuth(github, ssm, ssmParams, function (err) {
    if (err) {
      console.log(err);
      callback(err);
    } else {
      // https://api.github.com/repos/owner/repo/issues/number
      var pullRequestUrl = issue.url.split("/");
      var owner = pullRequestUrl[4];
      var repo = pullRequestUrl[5];
      var number = pullRequestUrl[7];
      github.pullRequests.get({
        owner: owner,
        repo: repo,
        number: number
      }).then(function(data) {
        callback(null, data.data);
      }).catch(function(err) {
        callback(err);
      });
    }
   });
}

function getObjectDefault(obj, key, defaultValue) {
    var value = obj[key];
    return value != undefined ? value : defaultValue;
}
