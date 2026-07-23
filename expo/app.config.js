const { execSync } = require("node:child_process");

function git(command, fallback = "unknown") {
  try {
    return execSync(command, { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || fallback;
  } catch {
    return fallback;
  }
}

module.exports = ({ config }) => {
  const revision = process.env.EAS_BUILD_GIT_COMMIT_HASH || git("git rev-parse HEAD");
  const shortRevision = revision === "unknown" ? revision : revision.slice(0, 8);
  return {
    ...config,
    extra: {
      ...config.extra,
      build: {
        revision,
        shortRevision,
        branch: process.env.EAS_BUILD_GIT_COMMIT_REF || git("git rev-parse --abbrev-ref HEAD"),
        createdAt: new Date().toISOString(),
      },
    },
  };
};
