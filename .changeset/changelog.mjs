// How `changeset version` writes an entry into CHANGELOG.md: the changeset's own text as one bullet, with no commit hash
// (the release notes and the CHANGELOG say what changed, not where; devkit's release.yml copies the version's section).
export default {
  getReleaseLine: async (changeset) => {
    const [first, ...rest] = changeset.summary.trim().split("\n");
    return `- ${first}${rest.map((line) => `\n  ${line}`.trimEnd()).join("")}`;
  },
  getDependencyReleaseLine: async () => "",
};
