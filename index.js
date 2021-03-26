const core = require("@actions/core");
const github = require("@actions/github");
const simpleGit = require("simple-git");

const getOrganization = async () => {
  const remotes = await simpleGit.default().getRemotes(true);
  const origin = remotes.find((remote) => remote.name === "origin");
  if (!origin) {
    throw new Error("Unable to find remote with name 'origin'");
  }

  const { pathname } = new URL(origin.refs.push);
  if (!pathname) {
    throw new Error(`Unable to extract pathname from ${origin.refs.push}`);
  }

  const organization = pathname.split("/")[0];
  if (!organization) {
    throw new Error(`Unable to extract organization from ${origin.refs.push}`);
  }
  return organization;
};

const setup = async () => {
  console.log("!! HELLO WORLD !!");
  const repoToken = core.getInput("repo-token");
  const rootEmail = core.getInput("root-email");
  const terraformCloudToken = core.getInput("terraform-cloud-token");

  // const { orgs: orgsApi } = github.getOctokit(repoToken);

  const orgId = await getOrganization();
  console.log("!!!! orgId", orgId);

  // TODO: Terraform Cloud init

  core.setOutput("organization", orgId);
};

(async () => {
  try {
    await setup();
  } catch (error) {
    core.setFailed(error.message);
  }
})();
