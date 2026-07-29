/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
module.exports = function(api) {
  api.cache(true);
  return {presets: ['babel-preset-expo']};
};
