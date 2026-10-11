// SPDX-License-Identifier: AGPL-3.0-only
// The project ops a socket asks, answered off the runtime's projects: what the reply carries beside id and ok.
import type { Caller, RuntimeRequest } from "@wsp/protocol";
import type { Runtime } from "./types/api.js";

export type ProjectRequest = Extract<RuntimeRequest, { op: `projects.${string}` }>;

export const isProjectRequest = (msg: RuntimeRequest): msg is ProjectRequest => msg.op.startsWith("projects.");

export async function answerProject(projects: Runtime["projects"], msg: ProjectRequest, origin: Caller | undefined): Promise<Record<string, unknown>> {
  switch (msg.op) {
    case "projects.add": {
      const { notice, ...project } = await projects.add({ source: msg.source, ...(msg.on !== undefined ? { on: msg.on } : {}), ...(msg.name !== undefined ? { name: msg.name } : {}), ...(msg.base !== undefined ? { base: msg.base } : {}), ...(msg.into !== undefined ? { into: msg.into } : {}), ...(msg.seed !== undefined ? { seed: msg.seed } : {}) }, origin);
      return { project, ...(notice !== undefined ? { notice } : {}) };
    }
    case "projects.list":
      return { projects: await projects.list(origin) };
    case "projects.defaults":
      return { defaults: await projects.defaults(origin) };
    case "projects.resolve":
      return { project: await projects.resolve(msg.ref, origin) };
    case "projects.branch":
      return { ...(await projects.branch(msg.projectId, origin)) };
    case "projects.remove":
      return { ...(await projects.remove(msg.projectId, origin, { ...(msg.force === true ? { force: true } : {}), ...(msg.check === true ? { check: true } : {}) })) };
    case "projects.icon":
      return { ...(await projects.icon(msg.projectId, msg.png)) };
    case "projects.icons":
      return { icons: await projects.icons(msg.hashes) };
  }
}
