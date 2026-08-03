import { describe, expect, it } from "vitest";
import {
  extractContainerIdCandidates,
  ProjectResolutionError,
  resolveSelfIdentity,
  verifySelfContainer,
  type DockerInspectResult,
} from "./project.js";

const CONTAINER_ID = "b".repeat(64);
const IMAGE_LAYER_ID = "c".repeat(64);

const MOUNTINFO = [
  "1234 1200 0:60 / / rw,relatime - overlay overlay rw,upperdir=/var/lib/docker/overlay2/" + IMAGE_LAYER_ID + "/diff",
  `1240 1234 0:65 /repo /repo rw,relatime - ext4 /dev/sda1 rw`,
  `1250 1234 259:1 /var/lib/docker/containers/${CONTAINER_ID}/resolv.conf /etc/resolv.conf rw,relatime - ext4 /dev/sda1 rw`,
].join("\n");

const CGROUP = "0::/system.slice/docker-" + CONTAINER_ID + ".scope";

const validInspect: DockerInspectResult = {
  Id: CONTAINER_ID,
  Config: {
    Hostname: CONTAINER_ID.slice(0, 12),
    Labels: {
      "com.docker.compose.project": "meine-lokyy-installation",
      "com.docker.compose.service": "lokyy-updater",
      "com.docker.compose.project.working_dir": "/home/user/meine-lokyy-installation",
    },
  },
  Mounts: [
    { Destination: "/repo", Source: "/home/user/meine-lokyy-installation" },
    { Destination: "/var/run/docker.sock", Source: "/var/run/docker.sock" },
  ],
};

describe("extractContainerIdCandidates", () => {
  it("prefers the ID the daemon bind-mounts into every container", () => {
    const candidates = extractContainerIdCandidates("host-override", MOUNTINFO, CGROUP);
    expect(candidates[0]).toBe(CONTAINER_ID);
  });

  it("still finds the ID when only the hostname carries it", () => {
    expect(extractContainerIdCandidates(CONTAINER_ID.slice(0, 12), "", "")).toEqual([CONTAINER_ID.slice(0, 12)]);
  });

  it("returns nothing usable when /proc tells us nothing", () => {
    expect(extractContainerIdCandidates("not-a-container-id", "", "")).toEqual([]);
  });
});

describe("verifySelfContainer", () => {
  it("accepts a container that matches on ID, both labels and the /repo mount", () => {
    const verdict = verifySelfContainer(validInspect, CONTAINER_ID);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.identity.project).toBe("meine-lokyy-installation");
      expect(verdict.identity.service).toBe("lokyy-updater");
    }
  });

  it("rejects a container that is not the candidate we asked about", () => {
    const verdict = verifySelfContainer({ ...validInspect, Id: "d".repeat(64) }, CONTAINER_ID);
    expect(verdict).toMatchObject({ ok: false });
  });

  it("rejects a container without the /repo mount — it cannot be the updater", () => {
    const verdict = verifySelfContainer({ ...validInspect, Mounts: [] }, CONTAINER_ID);
    expect(verdict).toMatchObject({ ok: false, reason: expect.stringContaining("/repo") });
  });

  it("rejects a container that carries no compose project label", () => {
    const verdict = verifySelfContainer(
      { ...validInspect, Config: { Labels: { "com.docker.compose.service": "lokyy-updater" } } },
      CONTAINER_ID,
    );
    expect(verdict).toMatchObject({ ok: false });
  });
});

describe("resolveSelfIdentity", () => {
  const deps = (inspect: (id: string) => Promise<DockerInspectResult | null>) => ({
    inspectContainer: inspect,
    hostname: () => CONTAINER_ID.slice(0, 12),
    readMountInfo: () => MOUNTINFO,
    readCgroup: () => CGROUP,
  });

  it("reads the project name off our own labels", async () => {
    const identity = await resolveSelfIdentity(deps(async () => validInspect));
    expect(identity.project).toBe("meine-lokyy-installation");
  });

  it("skips image layer IDs that do not resolve to a container", async () => {
    const identity = await resolveSelfIdentity(
      deps(async (id) => (id === CONTAINER_ID ? validInspect : null)),
    );
    expect(identity.containerId).toBe(CONTAINER_ID);
  });

  it("REFUSES rather than guessing when nothing can be identified", async () => {
    // This is the single most important behaviour in the file. A guessed
    // project name creates a second stack on empty volumes.
    await expect(resolveSelfIdentity(deps(async () => null))).rejects.toBeInstanceOf(ProjectResolutionError);
    await expect(resolveSelfIdentity(deps(async () => null))).rejects.toThrow(/Refusing to update/);
  });

  it("refuses when the docker socket is unreachable", async () => {
    await expect(
      resolveSelfIdentity(
        deps(async () => {
          throw new Error("Cannot connect to the Docker daemon");
        }),
      ),
    ).rejects.toThrow(/Refusing to update/);
  });

  it("refuses when /proc yields no candidate at all", async () => {
    await expect(
      resolveSelfIdentity({
        inspectContainer: async () => validInspect,
        hostname: () => "some-alias",
        readMountInfo: () => "",
        readCgroup: () => "",
      }),
    ).rejects.toThrow(/refusing to guess/);
  });
});
