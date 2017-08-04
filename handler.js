'use strict';

var AWS = require('aws-sdk');
var codebuild = new AWS.CodeBuild();
var ssm = new AWS.SSM();

var GitHubApi = require("github");
var github = new GitHubApi();
var BUILD_ACTIONS = [
    "opened",
    "reopened",
    "synchronize"
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

// get the github status context
var githubContext = process.env.GITHUB_STATUS_CONTEXT;

// this function will be triggered by the github webhook
module.exports.start_build = (event, context, callback) => {

  var response = {
    pull_request: {},
    build: {}
  };

  // we only act on pull_request changes (can be any, but we don't need those)
  if('pull_request' in event) {

    if(BUILD_ACTIONS.indexOf(event.action) >= 0) {

      response.pull_request = event.pull_request
      var head = event.pull_request.head;
      var base = event.pull_request.base;
      var repo = base.repo;

      var params = {
        projectName: process.env.BUILD_PROJECT,
        sourceVersion: 'pr/' + event.pull_request.number
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
          github.repos.createStatus(status).then(function() {
            // start the codebuild  project
            codebuild.startBuild(params, function(err, data) {
              if (err) {
                console.log(err, err.stack);
                callback(err);
              } else {
                // store the build data in the response
                response.build = data.build;

                // all is well, mark the commit as being 'in progress'
                status.description = 'Build is running...'
                status.target_url = 'https://' + region + '.console.aws.amazon.com/codebuild/home?region=' + region + '#/builds/' + data.build.id + '/view/new'
                github.repos.createStatus(status).then(function(data){
                  // success
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
    } else {
      callback("Event is not a build action")
    }
  } else {
    callback("Not a PR");
  }
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
