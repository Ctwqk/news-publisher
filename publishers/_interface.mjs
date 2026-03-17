/**
 * Publisher interface definition for news-publisher.
 *
 * Every publisher module (e.g. x.mjs, xiaohongshu.mjs) must export
 * the three functions described below.
 *
 * @typedef {Object} NewsItem
 * @property {string} id       - Stable hash identifier
 * @property {string} source   - Feed source name / hostname
 * @property {string} title    - Article headline
 * @property {string} link     - Article URL
 * @property {string} pubDate  - ISO 8601 date string
 *
 * @typedef {Object} PostResult
 * @property {boolean} ok      - Whether the post succeeded
 * @property {string}  [id]    - Platform-assigned post ID (if available)
 * @property {string}  [error] - Error description (if failed)
 */

/**
 * Validate that a module satisfies the publisher interface.
 * Call this at startup — throws if any required export is missing.
 *
 * @param {Object} mod          - The imported publisher module
 * @param {string} publisherName - Name for error messages
 */
export function validatePublisher(mod, publisherName) {
  const required = ['validateConfig', 'formatItems', 'post'];
  const missing = required.filter((fn) => typeof mod[fn] !== 'function');
  if (missing.length > 0) {
    throw new Error(
      `Publisher "${publisherName}" is missing required exports: ${missing.join(', ')}`,
    );
  }
}
