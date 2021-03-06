/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */
'use strict';

var declareOpts = require('../lib/declareOpts');
var getAssetDataFromName = require('../lib/getAssetDataFromName');
var path = require('path');
var Promise = require('bluebird');
var fs = require('fs');
var crypto = require('crypto');

var lstat = Promise.promisify(fs.lstat);
var readDir = Promise.promisify(fs.readdir);
var readFile = Promise.promisify(fs.readFile);

module.exports = AssetServer;

var validateOpts = declareOpts({
  projectRoots: {
    type: 'array',
    required: true,
  },
  assetExts: {
    type: 'array',
    default: ['png'],
  },
});

function AssetServer(options) {
  var opts = validateOpts(options);
  this._roots = opts.projectRoots;
  this._assetExts = opts.assetExts;
}

/**
 * Given a request for an image by path. That could contain a resolution
 * postfix, we need to find that image (or the closest one to it's resolution)
 * in one of the project roots:
 *
 * 1. We first parse the directory of the asset
 * 2. We check to find a matching directory in one of the project roots
 * 3. We then build a map of all assets and their scales in this directory
 * 4. Then pick the closest resolution (rounding up) to the requested one
 */

AssetServer.prototype._getAssetRecord = function(assetPath) {
  var filename = path.basename(assetPath);

  return findRoot(
    this._roots,
    path.dirname(assetPath)
  ).then(function(dir) {
    return [
      dir,
      readDir(dir),
    ];
  }).spread(function(dir, files) {
    var assetData = getAssetDataFromName(filename);
    var map = buildAssetMap(dir, files);
    var record = map[assetData.assetName];

    if (!record) {
      throw new Error('Asset not found');
    }

    return record;
  });
};

AssetServer.prototype.get = function(assetPath) {
  var assetData = getAssetDataFromName(assetPath);
  return this._getAssetRecord(assetPath).then(function(record) {
    for (var i = 0; i < record.scales.length; i++) {
      if (record.scales[i] >= assetData.resolution) {
        return readFile(record.files[i]);
      }
    }

    return readFile(record.files[record.files.length - 1]);
  });
};

AssetServer.prototype.getAssetData = function(assetPath) {
  var nameData = getAssetDataFromName(assetPath);
  var data = {
    name: nameData.name,
    type: 'png',
  };

  return this._getAssetRecord(assetPath).then(function(record) {
    data.scales = record.scales;

    return Promise.all(
      record.files.map(function(file) {
        return lstat(file);
      })
    );
  }).then(function(stats) {
    var hash = crypto.createHash('md5');

    stats.forEach(function(stat) {
      hash.update(stat.mtime.getTime().toString());
    });

    data.hash = hash.digest('hex');
    return data;
  });
};

function findRoot(roots, dir) {
  return Promise.some(
    roots.map(function(root) {
      var absPath = path.join(root, dir);
      return lstat(absPath).then(function(stat) {
        if (!stat.isDirectory()) {
          throw new Error('Looking for dirs');
        }
        stat._path = absPath;
        return stat;
      });
    }),
    1
  ).spread(
    function(stat) {
      return stat._path;
    }
  );
}

function buildAssetMap(dir, files) {
  var assets = files.map(getAssetDataFromName);
  var map = Object.create(null);
  assets.forEach(function(asset, i) {
    var file = files[i];
    var record = map[asset.assetName];
    if (!record) {
      record = map[asset.assetName] = {
        scales: [],
        files: [],
      };
    }

    var insertIndex;
    var length = record.scales.length;
    for (insertIndex = 0; insertIndex < length; insertIndex++) {
      if (asset.resolution <  record.scales[insertIndex]) {
        break;
      }
    }
    record.scales.splice(insertIndex, 0, asset.resolution);
    record.files.splice(insertIndex, 0, path.join(dir, file));
  });

  return map;
}
