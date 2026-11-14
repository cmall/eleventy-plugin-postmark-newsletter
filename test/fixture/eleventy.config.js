const newsletter = require("../../index.js");

module.exports = function (eleventyConfig) {
  eleventyConfig.addPlugin(newsletter, {
    siteUrl: "https://example.com/",
    from: "Test Sender <sender@example.com>",
    timezone: "America/Vancouver",
    subscribers: "subscribers.csv",
  });
  return { dir: { input: "src", output: "_site" } };
};
