import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HostStore, machineHosts, parseSshConfig, parseTarget, sshConfigHosts } from "../hosts";

describe("ssh config", () => {
  it("lists concrete hosts with their first values", () => {
    const hosts = parseSshConfig(`
# my machines
Host b300 b300-alt
  HostName 203.0.113.7
  User ubuntu
  Port 2200
  IdentityFile ~/.ssh/nebius
  User ignored
Host *.internal
  User x
Match host foo
  User y
Host=lab
  HostName lab.example.org
`);
    expect(hosts).toEqual([
      { alias: "b300", hostName: "203.0.113.7", user: "ubuntu", port: 2200, identityFile: "~/.ssh/nebius" },
      { alias: "b300-alt", hostName: "203.0.113.7", user: "ubuntu", port: 2200, identityFile: "~/.ssh/nebius" },
      { alias: "lab", hostName: "lab.example.org" },
    ]);
  });
  it("follows Include", () => {
    const home = mkdtempSync(join(tmpdir(), "bhd-"));
    mkdirSync(join(home, ".ssh", "conf.d"), { recursive: true });
    writeFileSync(join(home, ".ssh", "config"), "Include conf.d/*.conf\nHost a\n");
    writeFileSync(join(home, ".ssh", "conf.d", "vm.conf"), "Host b\n  User u\n");
    expect(sshConfigHosts(home).map((h) => h.id)).toEqual(["ssh:b", "ssh:a"]);
  });
});

describe("parseTarget", () => {
  it("takes user@host[:port]", () => {
    expect(parseTarget("ubuntu@203.0.113.7")).toEqual({ target: "ubuntu@203.0.113.7", port: undefined });
    expect(parseTarget(" root@box.lan:2222 ")).toEqual({ target: "root@box.lan", port: 2222 });
    expect(parseTarget("u@h; rm -rf /")).toBeNull();
  });
});

describe("machines from blackhole up", () => {
  it("reads the records with their price", () => {
    const home = mkdtempSync(join(tmpdir(), "bhd-"));
    mkdirSync(join(home, "bh", "machines"), { recursive: true });
    writeFileSync(join(home, "bh", "machines", "bh-b300-ab12.json"), JSON.stringify({
      name: "bh-b300-ab12", provider: "nebius", gpu: "b300", size: "gpu-b300", region: "us-central1", login: "ubuntu",
      created: 1, address: "198.51.100.4", id: "vm-1", resources: [], state: "running", usd_per_hour: 8.5,
    }));
    const [h] = machineHosts({ BLACKHOLE_HOME: join(home, "bh") }, home);
    expect(h).toMatchObject({ id: "vm:bh-b300-ab12", kind: "vm", target: "ubuntu@198.51.100.4", ratePerHour: 8.5, state: "running", gpu: "b300" });
  });
});

describe("HostStore", () => {
  const settings = () => {
    const m = new Map<string, unknown>();
    return { get: <T,>(k: string, f: T) => (m.has(k) ? (m.get(k) as T) : f), set: (k: string, v: unknown) => void m.set(k, v) };
  };
  it("merges sources, keeps the user's rate apart, never overrides a VM's price", () => {
    const s = new HostStore(settings(), {
      ssh: () => [{ id: "ssh:b300", label: "b300", kind: "ssh", target: "b300", source: "ssh-config" }],
      vms: () => [{ id: "vm:bh-1", label: "bh-1", kind: "vm", target: "u@h", source: "blackhole-up", ratePerHour: 8.5, currency: "$" }],
    });
    s.add("root@box:2222", "box");
    s.update("ssh:b300", { ratePerHour: 6.1, venv: "~/bh-venv" });
    s.update("vm:bh-1", { ratePerHour: 1 });
    const l = s.list();
    expect(l.map((h) => h.id)).toEqual(["vm:bh-1", "app:root@box:2222", "ssh:b300"]);
    expect(s.get("ssh:b300")).toMatchObject({ ratePerHour: 6.1, currency: "$", venv: "~/bh-venv" });
    expect(s.get("vm:bh-1").ratePerHour).toBe(8.5);
    expect(s.get("app:root@box:2222")).toMatchObject({ target: "root@box", port: 2222 });
    s.remove("app:root@box:2222");
    expect(s.list()).toHaveLength(2);
  });
});
