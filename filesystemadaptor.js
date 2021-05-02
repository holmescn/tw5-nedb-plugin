/*\
title: $:/plugins/tiddlywiki/filesystem/filesystemadaptor.js
type: application/javascript
module-type: syncadaptor

A sync adaptor module for synchronising with the local filesystem via node.js APIs

[[SyncAdaptorModules|https://tiddlywiki.com/dev/static/SyncAdaptorModules.html]]

\*/
(function(){

  /*jslint node: true, browser: true */
  /*global $tw: false */
  "use strict";

  // Get a reference to the file system
  if ($tw.node) {
    var path = require("path"),
      Datastore = require('nedb');
  }

  function isSystemTiddler(arg) {
    var title = arg;
    if (typeof arg === "object") {
      title = arg.fields.title;
    }
    return /^\$:/.test(title);
  }

  function isDraftTiddler(arg) {
    var title = arg;
    if (typeof arg === "object") {
      title = arg.fields.title;
    }
    return /^Draft of/.test(title);
  }

  function tiddlerToDocument(tiddler) {
    var doc = Object.assign({}, tiddler.fields);
    return doc;
  }

  function documentToTiddlerFields(doc) {
    var fields = Object.assign({}, doc);
    return fields;
  }

  /**
   * constructor of sync adaptor
   * 
   * @param {*} options 
   */
  function FileSystemAdaptor(options) {
    var self = this;
    this.wiki = options.wiki;
    this.boot = options.boot || $tw.boot;
    this.logger = new $tw.utils.Logger("filesystem",{colour: "green"});
    // /StoryList cached in memory
    this.drafts = {};
    this.memcache = {
      "$:/StoryList": {}
    };
    // Create the <wiki>/tiddlers folder if it doesn't exist
    $tw.utils.createDirectory(this.boot.wikiTiddlersPath);
    // Create the <wiki>/tiddlers.db
    this.db = new Datastore({
      filename: path.join(this.boot.wikiTiddlersPath, "..", "tiddlers.db"),
      autoload: true,
    });
    // compact the database every 10 minutes.
    this.db.persistence.setAutocompactionInterval(600 * 1000);
    // wiki title is unique indexed
    this.db.ensureIndex({ fieldName: 'title', unique: true }, function (err) {
      if (err) {
        self.logger.log("ERROR: " + JSON.stringify(err));
      }
    });
  }

  FileSystemAdaptor.prototype.name = "filesystem";
  FileSystemAdaptor.prototype.supportsLazyLoading = false;

  FileSystemAdaptor.prototype.isReady = function() {
    // The file system adaptor is always ready
    return true;
  };

  /**
   * Gets the supplemental information that the adaptor needs to keep track of for a particular tiddler.
   * For example, the TiddlyWeb adaptor includes a bag field indicating the original bag of the tiddler.
   * 
   * @param {*} tiddler Target tiddler
   * @returns an object storing any additional information required by the adaptor.
   */
  FileSystemAdaptor.prototype.getTiddlerInfo = function(tiddler) {
    // Returns the existing fileInfo for the tiddler. To regenerate, call getTiddlerFileInfo().
    var title = tiddler.fields.title;
    this.logger.log("GetTiddlerInfo of " + title);
    if (isSystemTiddler(title)) {
      return this.boot.files[title];
    } else {
      return {};
    }
  };

  /**
   * Return a fileInfo object for a tiddler, creating it if necessary:
   *   filepath: the absolute path to the file containing the tiddler
   *   type: the type of the tiddler file (NOT the type of the tiddler -- see below)
   *   hasMetaFile: true if the file also has a companion .meta file
   * 
   * The boot process populates this.boot.files for each of the tiddler files that it loads.
   * The type is found by looking up the extension in $tw.config.fileExtensionInfo (eg "application/x-tiddler" for ".tid" files).
   * It is the responsibility of the filesystem adaptor to update this.boot.files for new files that are created.
   * 
   * @param {*} tiddler 
   * @param {*} callback 
   */
  FileSystemAdaptor.prototype.getTiddlerFileInfo = function(tiddler,callback) {
    // Always generate a fileInfo object when this fuction is called
    var title = tiddler.fields.title, newInfo, pathFilters, extFilters,
     fileInfo = this.boot.files[title];
    if(this.wiki.tiddlerExists("$:/config/FileSystemPaths")) {
      pathFilters = this.wiki.getTiddlerText("$:/config/FileSystemPaths","").split("\n");
    }
    if(this.wiki.tiddlerExists("$:/config/FileSystemExtensions")) {
      extFilters = this.wiki.getTiddlerText("$:/config/FileSystemExtensions","").split("\n");
    }
    newInfo = $tw.utils.generateTiddlerFileInfo(tiddler,{
      directory: this.boot.wikiTiddlersPath,
      pathFilters: pathFilters,
      extFilters: extFilters,
      wiki: this.wiki,
      fileInfo: fileInfo
    });
    callback(null,newInfo);
  };

  /**
   * Save a tiddler and invoke the callback with (err,adaptorInfo,revision)
   * 
   * @param {*} tiddler Tiddler to be saved
   * @param {*} callback function invoked with parameter err,adaptorInfo,revision
   * @param {*} options The tiddlerInfo maintained by the syncer for this tiddler
   */
  FileSystemAdaptor.prototype.saveTiddler = function(tiddler,callback,options) {
    var self = this;
    var tiddlerInfo = options.tiddlerInfo || {};
    var title = tiddler.title;

    this.logger.log(`save "${tiddler.fields.title}"`);

    if (isSystemTiddler(tiddler)) {
      this.getTiddlerFileInfo(tiddler,function(err,fileInfo) {
        if(err) {
          return callback(err);
        }
        if (tiddler.fields.title === "$:/StoryList") {
          self.storyList = Object.assign({}, tiddler.fields);
          return callback(null,fileInfo);
        } else {
          $tw.utils.saveTiddlerToFile(tiddler,fileInfo,function(err,fileInfo) {
            if(err) {
              if ((err.code == "EPERM" || err.code == "EACCES") && err.syscall == "open") {
                fileInfo = fileInfo || self.boot.files[tiddler.fields.title];
                fileInfo.writeError = true;
                self.boot.files[tiddler.fields.title] = fileInfo;
                $tw.syncer.logger.log("Sync failed for \""+tiddler.fields.title+"\" and will be retried with encoded filepath",encodeURIComponent(fileInfo.filepath));
                return callback(err);
              } else {
                return callback(err);
              }
            }
            // Store new boot info only after successful writes
            self.boot.files[tiddler.fields.title] = fileInfo;
            // Cleanup duplicates if the file moved or changed extensions
            var options = {
              adaptorInfo: tiddlerInfo.adaptorInfo || {},
              bootInfo: fileInfo || {},
              title: tiddler.fields.title
            };
            $tw.utils.cleanupTiddlerFiles(options,function(err,fileInfo) {
              if(err) {
                return callback(err);
              }
              return callback(null,fileInfo);
            });
          });
        }
      });
    
    } else if(isDraftTiddler(tiddler)) {
      this.drafts[title] = tiddler.fields;
      callback(null, null);
    } else if (this.memcache[title]) {
      this.memcache[title] = tiddler.fields;
      callback(null, null);
    } else {
      var title = tiddler.fields.title;
      this.db.update({ title }, tiddlerToDocument(tiddler), { upsert: true }, function(err) {
        if (err) {
          self.logger.log(tiddler);
        }
        callback(err);
      });
    }
  };

  /**
   * Load a tiddler and invoke the callback with (err,tiddlerFields)
   * We don't need to implement loading for the file system adaptor, because all the tiddler files will have been loaded during the boot process.
   * 
   * @param {*} title Title of tiddler to be retrieved
   * @param {*} callback function invoked with parameter err,tiddlerFields
   */
  FileSystemAdaptor.prototype.loadTiddler = function(title,callback) {
    this.logger.log(`load "${title}"`);

    if (this.memcache[title]) {
      callback(null, this.memcache[title]);
    } else if (!isSystemTiddler(title)) {
      this.db.findOne({ title: title }, function (err, doc) {
        self.logger.log("fetched " + JSON.stringify(doc));
        delete doc["_id"];
        if (err) {
          callback(err);
        } else {
          callback(null, documentToTiddlerFields(doc));
        }
      });
    } else {
      callback(null, null);
    }
  };

  /**
   * Delete a tiddler and invoke the callback with (err)
   * 
   * @param {*} title Title of tiddler to be deleted
   * @param {*} callback function invoked with parameter err
   * @param {*} options 
   */
  FileSystemAdaptor.prototype.deleteTiddler = function(title,callback,options) {
    var self = this,
    fileInfo = this.boot.files[title];
    this.logger.log(`delete "${title}"`);

    if(fileInfo) { // delete the system tiddler on disk
      $tw.utils.deleteTiddlerFile(fileInfo,function(err,fileInfo) {
        if(err) {
          if ((err.code == "EPERM" || err.code == "EACCES") && err.syscall == "unlink") {
            // Error deleting the file on disk, should fail gracefully
            $tw.syncer.displayError("Server desynchronized. Error deleting file for deleted tiddler \"" + title + "\"",err);
            return callback(null,fileInfo);
          } else {
            return callback(err);
          }
        }
        // Remove the tiddler from self.boot.files & return null adaptorInfo
        delete self.boot.files[title];
        return callback(null,null);
      });
    } else if (isDraftTiddler(title)) {
      delete this.drafts[title];
      callback(null, null);
    } else if (this.memcache[title]) {
      delete this.memcache[title];
      callback(null, null);
    } else {
      this.db.remove({ title: title }, { multi: true }, function (err, numRemoved) {
        // if (numRemoved > 0) self.logger.log(""+numRemoved+" "+title+" is removed");
        if (numRemoved > 0) self.logger.log(`${numRemoved} "${title}" ${numRemoved > 1 ? "are" : "is"} removed`);
        callback(err, null);
      });
    }
  };

  /**
   * Gets the revision ID associated with the specified tiddler title.
   * 
   * @param {string} title Tiddler title
   * @returns revision ID.
   */
  //FileSystemAdaptor.prototype.getTiddlerRevision = function(title) {}

  /**
   * Attempts to login to the server with specified credentials. This method is optional.
   * 
   * @param {string} username 
   * @param {string} password 
   * @param {Function} callback Callback function invoked with parameter `err`
   */
  //FileSystemAdaptor.prototype.login = function(username,password,callback) {}

  /**
   * Invoked by the syncer to display a custom login promopt. This method is optional.
   * The custom login prompt should send the widget message tm-login with the username and password in parameters username and password.
   * 
   * @param {object} syncer Reference to the syncer object making the call
   */
  //FileSystemAdaptor.prototype.displayLoginPrompt = function(syncer) {}

  /**
   * Attempts to logout of the server. This method is optional.
   * 
   * @param {Function} callback function invoked with parameter `err`
   */
  //FileSystemAdaptor.prototype.logout = function(callback) {}

  /**
   * Retrieves the titles of tiddlers that need to be updated from the server.
   * This method is optional. If an adaptor doesn't implement it then synchronisation will be unidirectional from the TiddlyWiki store to the adaptor,
   * but not the other way.
   * The syncer will use the getUpdatedTiddlers() method in preference to the getSkinnyTiddlers() method.
   * 
   * The data provided by the callback is as follows:
   * 
   * {
   *   modifications: [<array of title>],
   *   deletions: [<array of title>],
   * }
   * @param {*} syncer Reference to the syncer object making the call
   * @param {*} callback  function invoked with parameter err,data – see below
   */
  //FileSystemAdaptor.prototype.getUpdatedTiddlers = function(syncer,callback) {}

  /**
   * Retrieves a list of skinny tiddlers from the server.
   * This method is optional. If an adaptor doesn't implement
   * it then synchronisation will be unidirectional from the
   * TiddlyWiki store to the adaptor, but not the other way.
   * The syncer will use the getUpdatedTiddlers() method in preference to the getSkinnyTiddlers() method.
   * 
   * @param {*} callback function invoked with parameter err,tiddlers, where tiddlers is an array of tiddler field objects
   */
  //FileSystemAdaptor.prototype.getSkinnyTiddlers = function(callback) {}

  if($tw.node) {
    exports.adaptorClass = FileSystemAdaptor;
  }
})();