path = require 'path'
fs = require 'fs'
{EventEmitter} = require 'events'
_ = require 'lodash'
async = require 'async'
Datastore = require 'nedb'
{assign, groupBy} = require 'lodash'
indexer = require './musicindexer'
imageIndexer = require './imageindexer'

{
  compare,
  escapeRegExp,
  mapPathToFolder,
  mapTrackToFile,
  getPathRegex,
  immediatly
} = require './utils'

class MediaLibrary
  constructor: (options) ->
    @options = @_normalizeOptions(options)
    
    if @options.dataPath
      dbpath = path.join(@options.dataPath, 'ml-tracks.db')

    @db = new Datastore(filename: dbpath, autoload: true)
    
  _normalizeOptions: (options) ->
    options = _.clone(options)
    options.paths = options.paths.map((p) -> path.resolve(p))
    return options
    
  _prepareTrack: (rpath, stats, fpath, md, dir) ->
    track = md || {}
    track.path = fpath
    track.size = stats.size
    track.root = dir
    # save some RAM and disk space
    delete track.picture
    return track
    
  _scanDirectory: (dir, options, emitter, callback) ->
    self = @
    tracks = []
    indexer(dir, options)
    .on('file', (rpath, stats, fpath, md) ->
      track = self._prepareTrack(rpath, stats, fpath, md, dir)
      tracks.push(track)
      emitter.emit('track', track)
    )
    .on('error', (err) -> callback(err))
    .on('done', -> callback(null, tracks))
    .start()
    
  _getScanFilter: (exTracks) ->
    i = 0
    start = Date.now()
    exPaths = exTracks.map((t) -> t.path)
    (rpath, stats, fpath) ->
      index = exPaths.indexOf(fpath)
      return true if index == -1
      exTrack = exTracks[index]
      return exTrack.size != stats.size
    
  # scan the paths and returns the number of found file
  scan: (callback = _.noop) ->
    # only one scan allowed at a time
    return @_activeScan if @_activeScan
    
    # TODO: filter to speed up rescan
    self = @
    @_activeScan = true
    emitter = new EventEmitter()
    
    @db.find({}, (err, exTracks) ->
      return callback(err) if err
      filter = self._getScanFilter(exTracks)
      async.mapSeries(self.options.paths, (dir, callback) ->
        self._scanDirectory(dir, {filter}, emitter, callback)
      , (err, results) ->
        if err
          console.error('scan error', err)
          emitter.emit('error', err)
          return callback(err, null)
        tracks = _.flatten(results, true)
        self._addTracks(tracks, (err, tracks) ->
          return callback(err) if err
          callback(null, tracks)
          self._activeScan = false
          emitter.emit('done', tracks)
        )
      )
    )
    
    return emitter
    
  scanCovers: (callback) ->
    self = @
    db = @db
    async.mapSeries(@options.paths, (dir, callback) ->
      imageIndexer(dir)
        .on('error', (err) -> callback(err))
        .on('done', (results) -> callback(null, results))
        .start()
    , (err, results) ->
      # merge all results into one object
      results = assign.apply(null, results)
      self.tracks((err, tracks) ->
        # group tracks by directory
        tracksByDir = groupBy(tracks, (track) -> path.dirname(track.path))
        # create tracks/images pairs
        tracksImages = for dir, tracks of tracksByDir
          images = results[dir]
          {tracks, images}
        # filter if no images
        tracksImages = tracksImages.filter(({images}) -> !!images)
        async.mapSeries(tracksImages, ({tracks, images}, callback) ->
          covers = images.map((image) ->
            name: path.basename(image.fullPath)
            size: image.stats.size
          )
          db.update(
            { _id: { $in: tracks.map((t) -> t._id) }},
            { $set: { covers }},
            { multi: true },
            callback)
        , (err, results) ->
          totalResults = results.reduce(((a, b) -> a + b), 0)
          callback(null, totalResults)
        )
      )
    )
    
  _addTracks: (tracks, callback) ->
    db = @db
    paths = tracks.map((track) -> track.path)
    db.remove({ path: { $in: paths }}, {}, (err, numRemoved) ->
      return callback(err) if err
      db.insert(tracks, (err, tracks) ->
        return callback(new Error(err)) if err
        return callback(null, tracks)
      )
    )

  tracks: (query = {}, callback) ->
    # handle optional query argument
    if _.isFunction(query)
      callback = query
      query = {}
      
    q = _.clone(query)
    @db.find(q, (err, tracks) ->
      return callback(err) if err
      
      # sort by artist, album, track no
      tracks.sort((t1, t2) ->
        c = compare(t1.artist?[0], t2.artist?[0])
        return c if c != 0
        c = compare(t1.album, t2.album)
        return c if c != 0
        return compare(t1.track?.no, t2.track?.no)
      )
      
      callback(null, tracks)
    )

  artists: (query = {}, callback) ->
    # handle optional query argument
    if _.isFunction(query)
      callback = query
      query = {}
      
    q = _.clone(query)
    if q.name
      q.artist = query.name
      delete q.name

    @db.find(q, (err, tracks) ->
      return callback(err) if err
      artists = tracks
        .filter((t) -> t.artist && t.artist.length)
        .map((t) -> t.artist[0])
      artists = _.uniq(artists)
      artists = artists.sort().map((a) -> { name: a })
      callback(null, artists)
    )

  albums: (query = {}, callback) ->
    # handle optional query argument
    if _.isFunction(query)
      callback = query
      query = {}
      
    q = _.clone(query)
    if q.title
      q.album = q.title
      delete q.title
    if q.artist
      q.artist = query.artist

    @db.find(q, (err, tracks) ->
      return callback(err) if err
      albumtracks = tracks
        .filter((track) -> !!track.album)
        .map((track) ->
          title: track.album
          artist: track.albumartist?[0] || track.artist?[0]
          path: track.path
          dirpath: path.dirname(track.path)
          track_no: track.track?.no
          year: track.year
          _id: track._id
        )
      albums = _.chain(albumtracks)
        .groupBy('dirpath') # group by directory
        .map((pathtracks, dirpath) ->
          _.chain(pathtracks)
          .groupBy('title')
          .map((tracks, title) ->
            artists = _.uniq(tracks.map((t) -> t.artist))
            years = _.uniq(tracks.filter((t) -> !!t.year).map((t) -> t.year))
            return (
              title: title
              artist: (if artists.length > 1 then 'Various Artists' else artists[0])
              artists: artists
              year: (if years.length == 1 then years[0] else null)
              dirpath: dirpath
              tracks: _.sortBy(tracks.map((t) -> t._id), (t) -> t.track_no)
            )
          )
          .value()
        )
        .flatten(true) # true for one level flattening
        .sortBy('title')
        .value()
        
      callback(null, albums)
    )

  files: (p, callback) ->
    # handle optional p argument
    if _.isFunction(p)
      callback = p
      p = null
    
    unless p?
      return callback(null, @options.paths.map(mapPathToFolder))
    else
      p = path.resolve(p)
      names = fs.readdirSync(p)
      folders = names
        .map((name) -> path.join(p, name))
        .filter((p) -> fs.statSync(p).isDirectory())
        .map(mapPathToFolder)

      return @db.find({ path: getPathRegex(p) }, (err, tracks) -> 
        return callback(err) if err
        folders = folders.concat(tracks.map(mapTrackToFile))
        callback(null, folders)
      )

  findTracks: (track, callback) ->
    query = {}
    if track.artist
      artistRegex = new RegExp([escapeRegExp(track.artist)].join(""), "i")
      query.artist = artistRegex
    if track.title
      titleRegex = new RegExp([escapeRegExp(track.title)].join(""), "i")
      query.title = titleRegex
    if track.album
      albumRegex = new RegExp([escapeRegExp(track.album)].join(""), "i")
      query.album = albumRegex
    @db.find(query, callback)


module.exports = MediaLibrary
