(function() {
  var Datastore, EventEmitter, MediaLibrary, _, assign, async, compare, escapeRegExp, fs, getPathRegex, groupBy, imageIndexer, immediatly, indexer, mapPathToFolder, mapTrackToFile, path, ref, ref1;

  path = require('path');

  fs = require('fs');

  EventEmitter = require('events').EventEmitter;

  _ = require('lodash');

  async = require('async');

  Datastore = require('nedb');

  ref = require('lodash'), assign = ref.assign, groupBy = ref.groupBy;

  indexer = require('./musicindexer');

  imageIndexer = require('./imageindexer');

  ref1 = require('./utils'), compare = ref1.compare, escapeRegExp = ref1.escapeRegExp, mapPathToFolder = ref1.mapPathToFolder, mapTrackToFile = ref1.mapTrackToFile, getPathRegex = ref1.getPathRegex, immediatly = ref1.immediatly;

  MediaLibrary = (function() {
    function MediaLibrary(options) {
      var dbpath;
      this.options = this._normalizeOptions(options);
      if (this.options.dataPath) {
        dbpath = path.join(this.options.dataPath, 'ml-tracks.db');
      }
      this.db = new Datastore({
        filename: dbpath,
        autoload: true
      });
    }

    MediaLibrary.prototype._normalizeOptions = function(options) {
      options = _.clone(options);
      options.paths = options.paths.map(function(p) {
        return path.resolve(p);
      });
      return options;
    };

    MediaLibrary.prototype._prepareTrack = function(rpath, stats, fpath, md, dir) {
      var track;
      track = md || {};
      track.path = fpath;
      track.size = stats.size;
      track.root = dir;
      delete track.picture;
      return track;
    };

    MediaLibrary.prototype._scanDirectory = function(dir, options, emitter, callback) {
      var self, tracks;
      self = this;
      tracks = [];
      return indexer(dir, options).on('file', function(rpath, stats, fpath, md) {
        var track;
        track = self._prepareTrack(rpath, stats, fpath, md, dir);
        tracks.push(track);
        return emitter.emit('track', track);
      }).on('error', function(err) {
        return callback(err);
      }).on('done', function() {
        return callback(null, tracks);
      }).start();
    };

    MediaLibrary.prototype._getScanFilter = function(exTracks) {
      var exPaths, i, start;
      i = 0;
      start = Date.now();
      exPaths = exTracks.map(function(t) {
        return t.path;
      });
      return function(rpath, stats, fpath) {
        var exTrack, index;
        index = exPaths.indexOf(fpath);
        if (index === -1) {
          return true;
        }
        exTrack = exTracks[index];
        return exTrack.size !== stats.size;
      };
    };

    MediaLibrary.prototype.scan = function(callback) {
      var emitter, self;
      if (callback == null) {
        callback = _.noop;
      }
      if (this._activeScan) {
        return this._activeScan;
      }
      self = this;
      this._activeScan = true;
      emitter = new EventEmitter();
      this.db.find({}, function(err, exTracks) {
        var filter;
        if (err) {
          return callback(err);
        }
        filter = self._getScanFilter(exTracks);
        return async.mapSeries(self.options.paths, function(dir, callback) {
          return self._scanDirectory(dir, {
            filter: filter
          }, emitter, callback);
        }, function(err, results) {
          var tracks;
          if (err) {
            console.error('scan error', err);
            emitter.emit('error', err);
            return callback(err, null);
          }
          tracks = _.flatten(results, true);
          return self._addTracks(tracks, function(err, tracks) {
            if (err) {
              return callback(err);
            }
            callback(null, tracks);
            self._activeScan = false;
            return emitter.emit('done', tracks);
          });
        });
      });
      return emitter;
    };

    MediaLibrary.prototype.scanCovers = function(callback) {
      var db, self;
      self = this;
      db = this.db;
      return async.mapSeries(this.options.paths, function(dir, callback) {
        return imageIndexer(dir).on('error', function(err) {
          return callback(err);
        }).on('done', function(results) {
          return callback(null, results);
        }).start();
      }, function(err, results) {
        results = assign.apply(null, results);
        return self.tracks(function(err, tracks) {
          var dir, images, tracksByDir, tracksImages;
          tracksByDir = groupBy(tracks, function(track) {
            return path.dirname(track.path);
          });
          tracksImages = (function() {
            var results1;
            results1 = [];
            for (dir in tracksByDir) {
              tracks = tracksByDir[dir];
              images = results[dir];
              results1.push({
                tracks: tracks,
                images: images
              });
            }
            return results1;
          })();
          tracksImages = tracksImages.filter(function(arg) {
            var images;
            images = arg.images;
            return !!images;
          });
          return async.mapSeries(tracksImages, function(arg, callback) {
            var covers, images, tracks;
            tracks = arg.tracks, images = arg.images;
            covers = images.map(function(image) {
              return {
                name: path.basename(image.fullPath),
                size: image.stats.size
              };
            });
            return db.update({
              _id: {
                $in: tracks.map(function(t) {
                  return t._id;
                })
              }
            }, {
              $set: {
                covers: covers
              }
            }, {
              multi: true
            }, callback);
          }, function(err, results) {
            var totalResults;
            totalResults = results.reduce((function(a, b) {
              return a + b;
            }), 0);
            return callback(null, totalResults);
          });
        });
      });
    };

    MediaLibrary.prototype._addTracks = function(tracks, callback) {
      var db, paths;
      db = this.db;
      paths = tracks.map(function(track) {
        return track.path;
      });
      return db.remove({
        path: {
          $in: paths
        }
      }, {}, function(err, numRemoved) {
        if (err) {
          return callback(err);
        }
        return db.insert(tracks, function(err, tracks) {
          if (err) {
            return callback(new Error(err));
          }
          return callback(null, tracks);
        });
      });
    };

    MediaLibrary.prototype.tracks = function(query, callback) {
      var q;
      if (query == null) {
        query = {};
      }
      if (_.isFunction(query)) {
        callback = query;
        query = {};
      }
      q = _.clone(query);
      return this.db.find(q, function(err, tracks) {
        if (err) {
          return callback(err);
        }
        tracks.sort(function(t1, t2) {
          var c, ref2, ref3, ref4, ref5;
          c = compare((ref2 = t1.artist) != null ? ref2[0] : void 0, (ref3 = t2.artist) != null ? ref3[0] : void 0);
          if (c !== 0) {
            return c;
          }
          c = compare(t1.album, t2.album);
          if (c !== 0) {
            return c;
          }
          return compare((ref4 = t1.track) != null ? ref4.no : void 0, (ref5 = t2.track) != null ? ref5.no : void 0);
        });
        return callback(null, tracks);
      });
    };

    MediaLibrary.prototype.artists = function(query, callback) {
      var q;
      if (query == null) {
        query = {};
      }
      if (_.isFunction(query)) {
        callback = query;
        query = {};
      }
      q = _.clone(query);
      if (q.name) {
        q.artist = query.name;
        delete q.name;
      }
      return this.db.find(q, function(err, tracks) {
        var artists;
        if (err) {
          return callback(err);
        }
        artists = tracks.filter(function(t) {
          return t.artist && t.artist.length;
        }).map(function(t) {
          return t.artist[0];
        });
        artists = _.uniq(artists);
        artists = artists.sort().map(function(a) {
          return {
            name: a
          };
        });
        return callback(null, artists);
      });
    };

    MediaLibrary.prototype.albums = function(query, callback) {
      var q;
      if (query == null) {
        query = {};
      }
      if (_.isFunction(query)) {
        callback = query;
        query = {};
      }
      q = _.clone(query);
      if (q.title) {
        q.album = q.title;
        delete q.title;
      }
      if (q.artist) {
        q.artist = query.artist;
      }
      return this.db.find(q, function(err, tracks) {
        var albums, albumtracks;
        if (err) {
          return callback(err);
        }
        albumtracks = tracks.filter(function(track) {
          return !!track.album;
        }).map(function(track) {
          var ref2, ref3, ref4;
          return {
            title: track.album,
            artist: ((ref2 = track.albumartist) != null ? ref2[0] : void 0) || ((ref3 = track.artist) != null ? ref3[0] : void 0),
            path: track.path,
            dirpath: path.dirname(track.path),
            track_no: (ref4 = track.track) != null ? ref4.no : void 0,
            year: track.year,
            _id: track._id
          };
        });
        albums = _.chain(albumtracks).groupBy('dirpath').map(function(pathtracks, dirpath) {
          return _.chain(pathtracks).groupBy('title').map(function(tracks, title) {
            var artists, years;
            artists = _.uniq(tracks.map(function(t) {
              return t.artist;
            }));
            years = _.uniq(tracks.filter(function(t) {
              return !!t.year;
            }).map(function(t) {
              return t.year;
            }));
            return {
              title: title,
              artist: (artists.length > 1 ? 'Various Artists' : artists[0]),
              artists: artists,
              year: (years.length === 1 ? years[0] : null),
              dirpath: dirpath,
              tracks: _.sortBy(tracks.map(function(t) {
                return t._id;
              }), function(t) {
                return t.track_no;
              })
            };
          }).value();
        }).flatten(true).sortBy('title').value();
        return callback(null, albums);
      });
    };

    MediaLibrary.prototype.files = function(p, callback) {
      var folders, names;
      if (_.isFunction(p)) {
        callback = p;
        p = null;
      }
      if (p == null) {
        return callback(null, this.options.paths.map(mapPathToFolder));
      } else {
        p = path.resolve(p);
        names = fs.readdirSync(p);
        folders = names.map(function(name) {
          return path.join(p, name);
        }).filter(function(p) {
          return fs.statSync(p).isDirectory();
        }).map(mapPathToFolder);
        return this.db.find({
          path: getPathRegex(p)
        }, function(err, tracks) {
          if (err) {
            return callback(err);
          }
          folders = folders.concat(tracks.map(mapTrackToFile));
          return callback(null, folders);
        });
      }
    };

    MediaLibrary.prototype.findTracks = function(track, callback) {
      var albumRegex, artistRegex, query, titleRegex;
      query = {};
      if (track.artist) {
        artistRegex = new RegExp([escapeRegExp(track.artist)].join(""), "i");
        query.artist = artistRegex;
      }
      if (track.title) {
        titleRegex = new RegExp([escapeRegExp(track.title)].join(""), "i");
        query.title = titleRegex;
      }
      if (track.album) {
        albumRegex = new RegExp([escapeRegExp(track.album)].join(""), "i");
        query.album = albumRegex;
      }
      return this.db.find(query, callback);
    };

    return MediaLibrary;

  })();

  module.exports = MediaLibrary;

}).call(this);
