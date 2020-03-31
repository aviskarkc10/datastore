/*eslint no-console: "off"*/
import Datastore from "./datastore";
import Client from "./client";
import store from 'store';
import Keyring from './keyring';
import _ from 'lodash';
import Database from './database';
import App from './app';
import crypto from 'crypto';
import Utils from './utils';

const STORAGE_KEY = 'VERIDA_SESSION_';

class DataServer {

    constructor(config) {
        let defaults = {
            datastores: {}
        };
        this.config = _.merge(defaults, config);

        this.appName = config.appName ? config.appName : App.config.appName;
        this.appHost = config.appHost ? config.appHost : App.config.appHost;
        this.serverUrl = config.serverUrl;
        this.isProfile = config.isProfile ? config.isProfile : false;

        this._client = new Client(this);

        // By default, dataserver access is public only
        this._publicCredentials = null;
        this._datastores = {};  // @todo: difference if public v nonpublic?

        this._user = null;
        this._keyring = null;
        this._vid = null;
        this._dsn = null;


/*
        // Database connection string to connect to this user's data server for this app
        this._dsn = null;

        // @todo can this be removed?
        this._salt = null;

        // default symetric encryption key for this dataserver
        this._key = null;
        
        // VID for the connected user and application
        this._vid = null;

        // VID doc for the connected user and application
        this._vidDoc = null;

        // Key that caches this dataserver credentials so they can be
        // rebuilt with re-requesting a user's signature
        this._storageKey = null;
*/
    }

    /**
     * Authorize a user to have full permissions to this dataserver
     * 
     * @param {*} force 
     */
    async connect(user, force) {
        if (this._userConfig && this._userConfig) {
            return true;
        }

        // Try to load config from local storage
        this._storageKey = STORAGE_KEY + this.appName + user.did;
        let config = store.get(this._storageKey);
        if (config) {
            this.unserialize(config, user);
            this._user = user;
            return true;
        }
        
        /**
         * Force a connection
         */
        if (force) {
            // NOTE: removed the isProfile check. see user.requestSignature
            let userConfig = await user.getAppConfig(this.appName);
            let dsUser = await this._getUser(user, userConfig.keyring.signature);
            
            config = {
                signature: userConfig.keyring.signature,
                vid: userConfig.vid,
                dsn: dsUser.dsn
            };

            this.unserialize(config, user);
            store.set(this._storageKey, this.serialize());
            this._user = user;

            return true;
        }

        return false;
    }

    /**
     * Load an external data server
     */
    async loadExternal(config) {
        this._vid = config.vid;
    }

    logout() {
        this._connected = false;
        store.remove(this._storageKey);
    }

    serialize() {
        return {
            signature: this._keyring.signature,
            dsn: this._dsn,
            vid: this._vid,
            publicCredentials: this._publicCredentials
        };
    }

    /**
     * 
     * @param {*} data 
     * @param {*} user 
     */
    unserialize(data, user) {
        // configure user related config
        this._keyring = new Keyring(data.signature);
        this._vid = data.vid;
        this._dsn = data.dsn;

        // configure client
        this._client.username = user ? user.did : null;
        this._client.signature = data.signature;
        this._publicCredentials = data.publicCredentials;
    }

    async _getUser(user, signature) {
        // Fetch user details from server
        let response;
        try {
            this._client.username = user.did;
            this._client.signature = signature;
            response = await this._client.getUser(user.did);
        } catch (err) {
            if (err.response && err.response.data.data && err.response.data.data.did == "Invalid DID specified") {
                // User doesn't exist, so create
                response = await this._client.createUser(user.did, this._generatePassword(signature));
            }
            else if (err.response && err.response.statusText == "Unauthorized") {
                throw new Error("Invalid signature or permission to access DID server");
            }
            else {
                // Unknown error
                throw err;
            }
        }

        return response.data.user;
    }

    async getPublicCredentials() {
        if (this._publicCredentials) {
            return this._publicCredentials;
        }

        let response = await this._client.getPublicUser();
        this._publicCredentials = response.data.user;
        return this._publicCredentials;
    }

    /**
     * 
     * @param {*} dbName 
     * @param {*} config 
     */
    async openDatabase(dbName, config) {
        config = _.merge({
            permissions: {
                read: "owner",
                write: "owner"
            },
            user: this._user,
            did: this.config.did
        }, config);

        // If permissions require "owner" access, connect the current user
        if ((config.permissions.read == "owner" || config.permissions.write == "owner") && !config.readOnly) {
            if (!config.readOnly && !config.user) {
                throw new Error("Unable to open database. Permissions require \"owner\" access, but no user supplied in config.");
            }

            await this.connect(config.user, true);
        }

        // Default to user's did if not specified
        let did = config.did;
        if (config.user) {
            did = config.did || config.user.did;
            config.isOwner = (did == (config.user ? config.user.did : false));
        }

        did = did.toLowerCase();

        // TODO: Cache databases so we don't open the same one more than once
        return new Database(dbName, did, this.appName, this, config);
    }

    async openDatastore(schemaName, config) {
        config = _.merge({
            permissions: {
                read: "owner",
                write: "owner"
            },
            user: this._user,
            did: this.config.did
        }, config);

        // Default to user's did if not specified
        let did = config.did;
        if (config.user) {
            did = config.did || config.user.did;
            config.isOwner = (did == (config.user ? config.user.did : false));
        }

        if (!did) {
            throw new Error("No DID specified in config and no user connected");
        }

        did = did.toLowerCase();

        let datastoreName = config.dbName ? config.dbName : schemaName;

        let dsHash = Utils.md5FromArray([
            datastoreName,
            did,
            config.permissions.read,
            config.permissions.write,
            config.readOnly ? true : false
        ]);

        if (this._datastores[dsHash]) {
            return this._datastores[dsHash];
        }

        // If permissions require "owner" access, connect the current user
        if ((config.permissions.read == "owner" || config.permissions.write == "owner") && !config.readOnly) {
            if (!config.user) {
                throw new Error("Unable to open database. Permissions require \"owner\" access, but no user supplied in config.");
            }

            await this.connect(config.user, true);
        }

        this._datastores[dsHash] = new Datastore(this, schemaName, did, this.appName, config);
        return this._datastores[dsHash];
    }

    /**
     * Get the default symmetric encryption key
     */
    async getKey(user) {
        if (!this._keyring) {
            await this.connect(user, true);
        }

        return this._keyring.symKey;
    }

    async getClient(user) {
        if (!this._keyring) {
            await this.connect(user, true);
        }

        return this._client;
    }

    async getDsn(user) {
        if (!this._keyring) {
            await this.connect(user, true);
        }

        return this._dsn;
    }

    _generatePassword(signature) {
        return crypto.createHash('sha256').update(signature).digest("hex");
    }

}

export default DataServer;