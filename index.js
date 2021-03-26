const core = require("@actions/core");
const github = require("@actions/github");
const simpleGit = require("simple-git");
const axios = require("axios");

const getOrgAndRepo = async () => {
  const remotes = await simpleGit.default().getRemotes(true);
  const origin = remotes.find((remote) => remote.name === "origin");
  if (!origin) {
    throw new Error("Unable to find remote with name 'origin'");
  }

  const { pathname } = new URL(origin.refs.push);
  if (!pathname) {
    throw new Error(`Unable to extract pathname from ${origin.refs.push}`);
  }

  const organization = pathname.split("/")[1];
  if (!organization) {
    throw new Error(`Unable to extract organization from ${pathname}`);
  }

  const repo = pathname.split("/")[2];
  if (!repo) {
    throw new Error(`Unable to extract repo from ${pathname}`);
  }

  return { organization, repo };
};

const terraformPost = async (url, data) => {
  const terraformCloudToken = core.getInput("terraform-cloud-token");

  const response = await axios.default.post(url, data, {
    headers: {
      Authorization: `Bearer ${terraformCloudToken}`,
      "Content-Type": "application/vnd.api+json",
    },
  });

  return response;
};

const createTerraformOrganization = async (organization) => {
  const rootEmail = core.getInput("root-email");

  try {
    const { status, data } = await terraformPost(
      "https://app.terraform.io/api/v2/organizations",
      {
        data: {
          type: "organizations",
          attributes: {
            name: organization,
            email: rootEmail,
          },
        },
      }
    );
    console.log(`Status Code: ${status}: Response: ${JSON.stringify(data)}`);
  } catch (e) {
    // TODO: Check message
    console.warn("Error creating organization: ", e);
  }
};

const createTerraformWorkspace = async (organization, workspace) => {
  const rootEmail = core.getInput("root-email");

  try {
    const { status, data } = terraformPost(
      `https://app.terraform.io/api/v2/organizations/${organization}/workspaces`,
      {
        data: {
          type: "workspaces",
          attributes: {
            name: workspace,
            operations: false,
          },
        },
      }
    );
    console.log(`Status Code: ${status}: Response: ${JSON.stringify(data)}`);
  } catch (e) {
    // TODO: Check message
    console.warn("Error creating workspace: ", e);
  }
};

const setup = async () => {
  const repoToken = core.getInput("repo-token");

  // const { orgs: orgsApi } = github.getOctokit(repoToken);

  const { organization, repo } = await getOrgAndRepo();
  core.setOutput("organization", organization);

  await createTerraformOrganization(organization);
  await createTerraformWorkspace(organization, repo);
};

(async () => {
  try {
    await setup();
  } catch (e) {
    core.setFailed(e.message);
  }
})();
