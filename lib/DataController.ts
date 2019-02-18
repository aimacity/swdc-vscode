const fs = require("fs");
const macaddress = require("getmac");

import {
    softwareGet,
    isResponseOk,
    isUserDeactivated,
    softwarePost
} from "./HttpClient";
import { fetchDailyKpmSessionInfo } from "./KpmStatsManager";
import {
    getItem,
    setItem,
    getSoftwareDataStoreFile,
    deleteFile,
    randomCode,
    getGitHubEmail,
    getSoftwareSessionFile
} from "./Util";

export async function serverIsAvailable() {
    return await softwareGet("/ping", null)
        .then(result => {
            return isResponseOk(result);
        })
        .catch(e => {
            return false;
        });
}

/**
 * checks if the user needs to be created
 */
export async function requiresUserCreation() {
    const sessionFile = getSoftwareSessionFile();
    // set the last auth check time to -1 if the sesison file doesn't yet exist
    const hasSessionFile = fs.existsSync(sessionFile);
    const serverAvailable = await serverIsAvailable();
    const existingJwt = getItem("jwt");

    if (serverAvailable && (!existingJwt || !hasSessionFile)) {
        return true;
    }
    return false;
}

/**
 * User session will have...
 * { user: user, jwt: jwt }
 */
export async function isAuthenticated() {
    const tokenVal = getItem("token");
    if (!tokenVal) {
        return false;
    }

    // since we do have a token value, ping the backend using authentication
    // in case they need to re-authenticate
    const resp = await softwareGet("/users/ping", getItem("jwt"));
    if (isResponseOk(resp)) {
        return true;
    } else {
        console.log("Code Time: The user is not logged in");
        return false;
    }
}

/**
 * send the offline data
 */
export function sendOfflineData() {
    const dataStoreFile = getSoftwareDataStoreFile();
    try {
        if (fs.existsSync(dataStoreFile)) {
            const content = fs.readFileSync(dataStoreFile).toString();
            if (content) {
                console.log(`Code Time: sending batch payloads: ${content}`);
                const payloads = content
                    .split(/\r?\n/)
                    .map(item => {
                        let obj = null;
                        if (item) {
                            try {
                                obj = JSON.parse(item);
                            } catch (e) {
                                //
                            }
                        }
                        if (obj) {
                            return obj;
                        }
                    })
                    .filter(item => item);
                softwarePost("/data/batch", payloads, getItem("jwt")).then(
                    async resp => {
                        if (isResponseOk(resp) || isUserDeactivated(resp)) {
                            const serverAvailablePromise = await serverIsAvailable();
                            if (serverAvailablePromise) {
                                // everything is fine, delete the offline data file
                                deleteFile(getSoftwareDataStoreFile());
                            }
                        }
                    }
                );
            }
        }
    } catch (e) {
        //
    }
}

/**
 * confirm the token that was saved in the app
 */
export async function checkTokenAvailability() {
    const tokenVal = getItem("token");

    if (!tokenVal) {
        return;
    }

    // need to get back...
    // response.data.user, response.data.jwt
    // non-authorization API
    softwareGet(`/users/plugin/confirm?token=${tokenVal}`, null)
        .then(resp => {
            if (
                isResponseOk(resp) &&
                resp.data &&
                resp.data.jwt &&
                resp.data.user
            ) {
                setItem("jwt", resp.data.jwt);
                setItem("user", resp.data.user);
                setItem("vscode_lastUpdateTime", Date.now());

                // fetch kpm data
                setTimeout(() => {
                    fetchDailyKpmSessionInfo();
                }, 1000);
            } else if (!isUserDeactivated(resp)) {
                console.log("Code Time: unable to obtain session token");
                // try again in 45 seconds
                setTimeout(() => {
                    checkTokenAvailability();
                }, 1000 * 50);
            } else if (isUserDeactivated(resp)) {
                console.log("Code Time: unable to obtain session token");
                // try again in a day
                setTimeout(() => {
                    checkTokenAvailability();
                }, 1000 * 60 * 60 * 24);
            }
        })
        .catch(err => {
            console.log(
                "Code Time: error confirming plugin token: ",
                err.message
            );
            setTimeout(() => {
                checkTokenAvailability();
            }, 1000 * 45);
        });
}

/**
 * send any music tracks
 */
export function sendMusicData(trackData) {
    // add the "local_start", "start", and "end"
    // POST the kpm to the PluginManager
    return softwarePost("/data/music", trackData, getItem("jwt"))
        .then(resp => {
            if (!isResponseOk(resp)) {
                return { status: "fail" };
            }
            return { status: "ok" };
        })
        .catch(e => {
            return { status: "fail" };
        });
}

/**
 * get the mac address
 */
export async function getMacAddress() {
    let result = await new Promise(function(resolve, reject) {
        macaddress.getMac(async (err, macAddress) => {
            if (err) {
                reject({ status: "failed", message: err.message });
            } else {
                resolve({ status: "success", macAddress });
            }
        });
    });
    if (result && result["status"] === "success") {
        return result["macAddress"];
    }
    return null;
}

/**
 * get the app jwt
 */
export async function getAppJwt() {
    let appJwt = getItem("app_jwt");

    let serverIsOnline = await serverIsAvailable();

    if (!appJwt && serverIsOnline) {
        let macAddress = await getMacAddress();
        if (macAddress) {
            // get the app jwt
            let resp = await softwareGet(
                `/data/token?addr=${encodeURIComponent(macAddress)}`,
                null
            );
            if (isResponseOk(resp)) {
                appJwt = resp.data.jwt;
                setItem("app_jwt", appJwt);
            }
        }
    }
    return getItem("app_jwt");
}

/**
 * create an anonymous user based on github email or mac addr
 */
export async function createAnonymousUser() {
    let appJwt = await getAppJwt();
    let jwt = await getItem("jwt");
    let macAddress = await getMacAddress();
    if (appJwt && !jwt) {
        let plugin_token = getItem("token");
        if (!plugin_token) {
            plugin_token = randomCode();
            setItem("token", plugin_token);
        }

        let email = null; //await getGitHubEmail();
        if (!email) {
            email = macAddress;
        }

        let timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        let resp = await softwarePost(
            `/data/onboard?addr=${encodeURIComponent(macAddress)}`,
            { email, plugin_token, timezone },
            getItem("app_jwt")
        );
        if (
            isResponseOk(resp) &&
            resp.data &&
            resp.data.jwt &&
            resp.data.user
        ) {
            setItem("jwt", resp.data.jwt);
            setItem("user", resp.data.user);
        } else {
            console.log(
                "Code Time: error confirming onboarding plugin token: ",
                resp.message
            );
        }
    }
}

/**
 * check if the user is registered or not
 */
export async function isRegisteredUser() {
    let jwt = getItem("jwt");
    let user = getItem("user");
    let serverIsOnline = await serverIsAvailable();
    let macAddress = await getMacAddress();
    if (jwt && serverIsOnline && user) {
        let userObj = JSON.parse(user);

        let api = `/users/${parseInt(userObj.id, 10)}`;
        let resp = await softwareGet(api, jwt);
        if (isResponseOk(resp)) {
            if (
                resp &&
                resp.data &&
                resp.data.data &&
                resp.data.data.email !== macAddress
            ) {
                return true;
            }
        }
    }
    return false;
}
