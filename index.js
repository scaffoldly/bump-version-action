const core = require("@actions/core");
const github = require("@actions/github");
const simpleGit = require("simple-git");
const axios = require("axios");
const { exec } = require("child_process");

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

const terraformPost = async (url, payload) => {
  const terraformCloudToken = core.getInput("terraform-cloud-token");

  try {
    const { status, data } = await axios.default.post(url, payload, {
      headers: {
        Authorization: `Bearer ${terraformCloudToken}`,
        "Content-Type": "application/vnd.api+json",
      },
    });

    return { status, data };
  } catch (e) {
    // ignore this type of response so our org/workspace creation is idempotent
    // {"errors":[{"status":"422","title":"invalid attribute","detail":"Name has already been taken","source":{"pointer":"/data/attributes/name"}}]}
    if (
      !e.response ||
      e.response.status !== 422 ||
      !e.response.data ||
      !e.response.data.errors ||
      e.response.data.errors.length !== 1 ||
      !e.response.data.errors[0] ||
      !e.response.data.errors[0].source ||
      !e.response.data.errors[0].source.pointer ||
      e.response.data.errors[0].source.pointer !== "/data/attributes/name"
    ) {
      console.error("Error posting to Terraform Cloud", e.message);
      throw e;
    }

    const { status, data } = e.response;

    return { status, data };
  }
};

const createTerraformOrganization = async (organization) => {
  const rootEmail = core.getInput("root-email");

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

  console.log(`[${status}] Create Org Response: ${JSON.stringify(data)}`);
};

const createTerraformWorkspace = async (organization, workspace) => {
  const { status, data } = await terraformPost(
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

  console.log(`[${status}] Create Workspace Response: ${JSON.stringify(data)}`);
};

const terraformInit = (organization) => {
  const terraformCloudToken = core.getInput("terraform-cloud-token");

  const command = `terraform init -backend-config="hostname=app.terraform.io" -backend-config="organization=${organization}" -backend-config="token=${terraformCloudToken}"`;

  return new Promise((resolve, reject) => {
    exec(command, (error, stdout) => {
      if (error) {
        reject(new Error(error));
        return;
      }
      resolve(stdout);
    });
  });
};

const run = async () => {
  const { organization, repo } = await getOrgAndRepo();
  core.setOutput("organization", organization);

  await createTerraformOrganization(organization);
  await createTerraformWorkspace(organization, repo);
  const stdout = await terraformInit(organization);

  console.log("!!! stdout", stdout);
};

(async () => {
  try {
    await run();
  } catch (e) {
    core.setFailed(e.message);
  }
})();
