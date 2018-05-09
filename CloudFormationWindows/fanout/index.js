'use strict';

console.log('Loading function');
var http = require('http');
var AWS = require('aws-sdk');

// The code outside of the handler is executed just the once. Make sure it doesn't need to be dynamic.

// Errors are formatted for processing by the API Gateway so that a caller gets useful diagnostics.
// So notice that it doesn't call callback( err ) as the caller would end up with a 502 error and no message or stack trace.
// Thus all calls to this Lambda function are 'successful'. It requires the API Gateway to interpret the statusCode
// and return that to the caller as the HTTP response.
function returnAPIError( statusCode, message, callback) {
    // Construct an error object so that we can omit constructError from the stack trace
    const myObject = {};
    Error.captureStackTrace(myObject, returnAPIError);

    let responseBody = {
        errorMessage: message,
        stackTrace: (myObject.stack)
    };
    console.log( "responseBody: ", responseBody);
    let response = {
        statusCode: statusCode,
        body: JSON.stringify(responseBody)
    };    
    if (callback) {
        callback( null, response);
    }
    
    return response;
}

exports.handler = (event, context, callback) => {
    context.callbackWaitsForEmptyEventLoop = false; // Errors need to be returned ASAP

    let hostedzoneid = '';
    let alias = '';
    let port = 8101;
    let appl = '';
    
    console.log("request: " + JSON.stringify(event));
    
    // 
    console.log("event.queryStringParameters" + JSON.stringify(event.queryStringParameters));

    if (event.queryStringParameters !== null && event.queryStringParameters !== undefined) {
        if (event.queryStringParameters.hostedzoneid !== undefined && 
            event.queryStringParameters.hostedzoneid !== null && 
            event.queryStringParameters.hostedzoneid !== "") {
            hostedzoneid = event.queryStringParameters.hostedzoneid;
            console.log("Received hostedzoneid: " + hostedzoneid);
        }

        
        if (event.queryStringParameters.alias !== undefined && 
            event.queryStringParameters.alias !== null && 
            event.queryStringParameters.alias !== "") {
            alias = event.queryStringParameters.alias;
            console.log("Received alias: " + alias);
        }
        
        if (event.queryStringParameters.port !== undefined && 
            event.queryStringParameters.port !== null && 
            event.queryStringParameters.port !== "") {
            port = event.queryStringParameters.port;
            console.log("Received port: " + port);
        }

        if (event.queryStringParameters.appl !== undefined && 
            event.queryStringParameters.appl !== null && 
            event.queryStringParameters.appl !== "") {
            appl = event.queryStringParameters.appl;
            console.log("Received appl: " + appl);
        }
        
    }

    // Mandatory parameters
    if ( hostedzoneid === "" || alias === "" || appl === "") {
        returnAPIError( 500, 'Error 500 hostedzoneid, alias and appl are mandatory parameters', callback);
        return;
    }
    
    // Any variables which need to be updated by multiple callbacks need to be declared before the first callback
    // otherwise each callback gets its own copy of the global.
    
    let instanceCount = 0;
    let successCodes = 0;
    
    let region = process.env.AWS_DEFAULT_REGION;

    let route53 = new AWS.Route53();
    
    let paramsListRRS = {
      HostedZoneId: hostedzoneid, /* required - paas.lansa.com */
      MaxItems: '1',
      StartRecordName: alias,
      StartRecordType: 'A'
    };

    // Async call
    route53.listResourceRecordSets(paramsListRRS, function(err, data) {
        if (err) {
            console.log(err, err.stack); // an error occurred
            returnAPIError( 500, err.message, callback);
            return;
        } 
        
        // successful response
        
        console.log('Searched for Alias: ', paramsListRRS.StartRecordName);
        if (data.ResourceRecordSets[0] === undefined || 
            data.ResourceRecordSets[0] === null || 
            data.ResourceRecordSets[0] === "") {
            
            console.log('Alias not found');
            returnAPIError( 500, 'Alias ' + paramsListRRS.StartRecordName + ' not found', callback);
            return;
        }
 
        console.log('Located Alias:      ', data.ResourceRecordSets[0].Name);
        if ( paramsListRRS.StartRecordName !== data.ResourceRecordSets[0].Name) {
            returnAPIError( 500, 'Searched for Alias is not the one located', callback);
            return;
        }
        
        console.log('ELB DNS Name: ', data.ResourceRecordSets[0].AliasTarget.DNSName);
        let DNSName = data.ResourceRecordSets[0].AliasTarget.DNSName;
        // e.g. paas-livb-webserve-ztessziszyzz-1633164328.us-east-1.elb.amazonaws.com.

        let DNSsplit = DNSName.split("."); 
        let ELBNameFull = '';
        let ELBsplit = '';
        console.log( 'DNSsplit[0]: ', DNSsplit[0]);
        if ( DNSsplit[0] === 'dualstack') {
            ELBNameFull = DNSsplit[1];
            region = DNSsplit[2];
        } else {
            ELBNameFull = DNSsplit[0];
            region = DNSsplit[1];
        }
        ELBsplit = ELBNameFull.split("-");
        ELBsplit.pop(); // remove last element

        // Put ELB Name back together again
        let i;
        let ELBLowerCase = '';
        for (i = 0; i < ELBsplit.length; i++) {
            ELBLowerCase += ELBsplit[i];
            if ( i < ELBsplit.length - 1 ) {
                ELBLowerCase += "-";
            }
        } 
        
        console.log( 'Region: ' + region );
        console.log( 'ELB:    ' + ELBLowerCase );
        
        AWS.config.update({region: region});
        
        // Need the region to be set before creating these variables.
        
        let elb = new AWS.ELB();
        let ec2 = new AWS.EC2();        
        
        // Async call
        elb.describeLoadBalancers(function(err, data) {
            if (err) {
                console.log(err, err.stack); // an error occurred
                returnAPIError( 500, err.message, callback);
                return;
            }
            
            // successful response
            console.log('Instances: ', JSON.stringify(data.LoadBalancerDescriptions).substring(0,400));   
            console.log( 'length: ' , data.LoadBalancerDescriptions.length);
            
            // Find the lower case ELB name by listing all the load balancers in the region 
            // and doing a case insensitive compare
            
            let i;
            let ELBNum = -1;
            let ELBCurrent = '';
            for (i = 0; i < data.LoadBalancerDescriptions.length; i++) {
                ELBCurrent =  data.LoadBalancerDescriptions[i].LoadBalancerName.toLowerCase();
                console.log( 'ELBCurrent: ', ELBCurrent );
                if ( ELBLowerCase === ELBCurrent) {
                    ELBNum = i;
                    break;
                }
            }            
            
            if ( ELBNum == -1 ) {
                returnAPIError( 500, 'ELB Name not found', callback);
                return;
            }
            let instances = data.LoadBalancerDescriptions[ELBNum].Instances;
            console.log('Instances: ', JSON.stringify(instances).substring(0,400));   

            // forEach is a Sync call
            Object.keys(instances).forEach(function(key) {
                console.log("InstanceId[" + key + "] " + JSON.stringify( instances[key].InstanceId ) );
                
                instanceCount++;
                
                let params = {
                    DryRun: false,
                    InstanceIds: [
                        instances[key].InstanceId
                    ]
                };
                
                // Async call
                ec2.describeInstances(params, function(err, data) {
                    if (err) {
                        console.log(err, err.stack); // an error occurred
                        returnAPIError( 500, err.message, callback);
                        return;
                    }
                    
                    // successful response
                    // console.log(data.Reservations[0].Instances[0]);        
                    let PublicIpAddress = data.Reservations[0].Instances[0].PublicIpAddress;
                    // console.log("Host: ", JSON.stringify( PublicIpAddress ) );

                    // post the payload from GitHub
                    //let post_data = JSON.stringify(message);
                    let post_data = "";

                    // console.log("post_data length: ", JSON.stringify( post_data.length ) );
                    
                    // An object of options to indicate where to post to
                    let post_options = {
                        host: PublicIpAddress,
                        port: port,
                        path: '/Deployment/Start/' + appl + '?source=GitHubWebHookReplication',
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Content-Length': post_data.length
                        }
                    };
                
                    // Async call
                    let post_request = http.request(post_options, function(res) {
                        let body = '';
            
                        if (res.statusCode === 200) {
                            successCodes++;
                            console.log('Application update successfully deployed by Lambda function to ' + post_options.host);
                            // console.log('successCodes: ' + successCodes + ' instanceCount: ' + instanceCount);
                            if ( successCodes >= instanceCount ){
                                console.log('Application update successfully deployed to stack ' + paramsListRRS.StartRecordName);  
                                
                                
                                let responseBody = {
                                    message: 'Application update successfully deployed to stack ' + paramsListRRS.StartRecordName,
                                    input: event.queryStringParameters
                                };
                                
                                // The output from a Lambda proxy integration must be 
                                // of the following JSON object. The 'headers' property 
                                // is for custom response headers in addition to standard 
                                // ones. The 'body' property  must be a JSON string. For 
                                // base64-encoded payload, you must also set the 'isBase64Encoded'
                                // property to 'true'.
                                let response = {
                                    statusCode: res.statusCode,
                                    headers: {
                                        "x-custom-header" : "my custom header value"
                                    },
                                    body: JSON.stringify(responseBody)
                                };
                                console.log("response: " + JSON.stringify(response));
                                
                                // Allow final states to be unwound before ending this invocation. E.g. Last 'End' is processed.
                                context.callbackWaitsForEmptyEventLoop = true; 
                                callback(null, response);                                
                                context.callbackWaitsForEmptyEventLoop = false; 
                            }
                        } else {
                            returnAPIError( res.statusCode, 'Error ' + res.statusCode + ' posting to ' + post_options.host + ':' + port + post_options.path, callback);
                            return;
                        }                        
                        
                        res.on('data', function(chunk)  {
                            body += chunk;
                        });
                
                        res.on('end', function() {
                            console.log( 'end ' + post_options.host );
                            // body is ready to return. Is this needed?
                        });
                
                        res.on('error', function(e) {
                            returnAPIError( e.code, e.message + ' Error ' + res.statusCode + ' posting to ' + post_options.host + ':' + port + post_options.path, callback);
                            return;
                        });
                    });    
                    // post the data
                    console.log( 'Posting to:', post_options.host, post_options.path );
                    post_request.write(post_data);
                    post_request.end();
                });                
            });
        });
    });    
};