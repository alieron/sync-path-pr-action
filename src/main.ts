import * as core from "@actions/core";
import { run } from "./action";

run().catch((error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
