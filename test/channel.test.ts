import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";
import { describe, it } from "node:test";
import { Channel, isNonce, newNonce } from "../module/scripts/channel.mjs";

const token = "test-token-0123456789abcdefghijklmnopqrstuv";
const clientNonce = Buffer.alloc(32, 1).toString("base64url");
const serverNonce = Buffer.alloc(32, 2).toString("base64url");

type Sent = { sealed: Uint8Array; counter: number };

async function channel(role: "server" | "client", nonces = { clientNonce, serverNonce }, key = token) {
  const sent: Sent[] = [];
  const created = await Channel.create({
    token: key,
    ...nonces,
    role,
    transmit: (sealed, counter) => sent.push({ sealed, counter })
  });
  return { channel: created, sent };
}

/** The protocol written out with node:crypto, independent of WebCrypto and of channel.mjs. */
function nodeSeal(direction: "client-to-server" | "server-to-client", counter: number, plaintext: string): Buffer {
  const salt = Buffer.concat([Buffer.from(clientNonce, "base64url"), Buffer.from(serverNonce, "base64url")]);
  const key = Buffer.from(hkdfSync("sha256", token, salt, `foundry-mcp/3 ${direction}`, 32));
  const iv = Buffer.alloc(12);
  iv.writeBigUInt64BE(BigInt(counter), 4);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  return Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
}

function nodeOpen(direction: "client-to-server" | "server-to-client", counter: number, sealed: Uint8Array): string {
  const salt = Buffer.concat([Buffer.from(clientNonce, "base64url"), Buffer.from(serverNonce, "base64url")]);
  const key = Buffer.from(hkdfSync("sha256", token, salt, `foundry-mcp/3 ${direction}`, 32));
  const iv = Buffer.alloc(12);
  iv.writeBigUInt64BE(BigInt(counter), 4);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(Buffer.from(sealed.subarray(-16)));
  return Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]).toString("utf8");
}

describe("channel", () => {
  it("seals exactly like an independent node:crypto implementation of HKDF-SHA256 and AES-256-GCM with counter IVs", async () => {
    const server = await channel("server");
    await server.channel.send({ type: "ready" });
    await server.channel.send({ type: "request", id: "r1" });
    assert.deepEqual(
      server.sent.map((s) => s.counter),
      [0, 1]
    );
    assert.equal(
      Buffer.from(server.sent[0]!.sealed).toString("hex"),
      nodeSeal("server-to-client", 0, '{"type":"ready"}').toString("hex")
    );
    assert.equal(
      Buffer.from(server.sent[0]!.sealed).toString("hex"),
      "d63efe90ba93003a4bf0f89597e966907d0319bf9a945276c0d10984dd1d8799",
      "pinned vector"
    );
    assert.equal(nodeOpen("server-to-client", 1, server.sent[1]!.sealed), '{"type":"request","id":"r1"}');

    const client = await channel("client");
    for (const [counter, text] of ['{"type":"auth"}', '{"type":"response"}'].entries()) {
      assert.deepEqual(await client.channel.receive(nodeSeal("server-to-client", counter, text)), { ok: true, text });
    }
    await client.channel.send({ type: "auth" });
    assert.equal(nodeOpen("client-to-server", 0, client.sent[0]!.sealed), '{"type":"auth"}');
  });

  it("gives frames 256 and 65536 an IV of their own, the one an independent implementation counts to", async () => {
    const server = await channel("server");
    await Promise.all(Array.from({ length: 65537 }, () => server.channel.send({ same: "plaintext" })));
    const distinct = new Set(server.sent.map((s) => Buffer.from(s.sealed).toString("base64")));
    assert.equal(distinct.size, 65537, "two frames of the same plaintext were sealed alike, so an IV was used twice");
    for (const counter of [255, 256, 257, 65535, 65536]) {
      assert.equal(nodeOpen("server-to-client", counter, server.sent[counter]!.sealed), '{"same":"plaintext"}');
    }
  });

  it("does not open a frame in the direction it was not sealed for", async () => {
    const client = await channel("client");
    await client.channel.send({ type: "auth" });
    const otherClient = await channel("client");
    assert.deepEqual(await otherClient.channel.receive(client.sent[0]!.sealed), { ok: false, reason: "forged" });
    const server = await channel("server");
    assert.equal((await server.channel.receive(client.sent[0]!.sealed)).ok, true, "control: the right direction opens");
  });

  it("does not open a frame from another session or under another token", async () => {
    const client = await channel("client");
    await client.channel.send({ type: "auth" });
    const sealed = client.sent[0]!.sealed;
    const otherSession = await channel("server", { clientNonce, serverNonce: newNonce() });
    assert.equal((await otherSession.channel.receive(sealed)).ok, false);
    const otherClientNonce = await channel("server", { clientNonce: newNonce(), serverNonce });
    assert.equal((await otherClientNonce.channel.receive(sealed)).ok, false);
    const otherToken = await channel("server", { clientNonce, serverNonce }, `${token}x`);
    assert.equal((await otherToken.channel.receive(sealed)).ok, false);
  });

  async function threeFrames() {
    const sender = await channel("server");
    for (const n of [0, 1, 2]) await sender.channel.send({ n });
    return sender.sent.map((s) => s.sealed);
  }

  for (const [label, order] of [
    ["reordered", [1, 0, 2]],
    ["duplicated", [0, 0, 1]],
    ["dropped", [0, 2, 1]]
  ] as const) {
    it(`fails on ${label} frames and stays poisoned, even for the frame that would have been next`, async () => {
      const frames = await threeFrames();
      const receiver = await channel("client");
      const results = [];
      for (const index of order) results.push(await receiver.channel.receive(frames[index]!));
      const firstBad = results.findIndex((result) => !result.ok);
      assert.ok(firstBad >= 0, "a frame out of order opened");
      assert.equal(results[firstBad]!.ok === false && results[firstBad]!.reason, "forged");
      for (const later of results.slice(firstBad + 1)) assert.equal(later.ok, false);
      for (const frame of frames)
        assert.deepEqual(await receiver.channel.receive(frame), { ok: false, reason: "poisoned" });
    });
  }

  it("rejects a tampered frame, a frame shorter than the tag and a non-binary value", async () => {
    for (const bad of [
      (f: Uint8Array) => f.map((byte, i) => (i === 3 ? byte ^ 1 : byte)),
      () => new Uint8Array(15),
      () => "text" as never
    ]) {
      const [first] = await threeFrames();
      const receiver = await channel("client");
      assert.deepEqual(await receiver.channel.receive(bad(first!)), { ok: false, reason: "forged" });
    }
  });

  it("delivers many concurrent sends of very different sizes in call order, and opens them in that order", async () => {
    const sender = await channel("server");
    const sizes = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 2_000_000 - i * 1000 : i));
    await Promise.all(sizes.map((size, i) => sender.channel.send({ i, pad: "x".repeat(size) })));
    assert.deepEqual(
      sender.sent.map((s) => s.counter),
      sizes.map((_, i) => i)
    );
    const receiver = await channel("client");
    const resolved: number[] = [];
    const opened = await Promise.all(
      sender.sent.map((s, i) => receiver.channel.receive(s.sealed).finally(() => resolved.push(i)))
    );
    assert.deepEqual(
      opened.map((o) => (o.ok ? JSON.parse(o.text).i : "failed")),
      sizes.map((_, i) => i)
    );
    assert.deepEqual(
      resolved,
      sizes.map((_, i) => i),
      "opens resolved out of arrival order"
    );
  });

  it("poisons a frame that arrived after a bad one even while both are still being opened", async () => {
    const frames = await threeFrames();
    const receiver = await channel("client");
    const [bad, next] = await Promise.all([
      receiver.channel.receive(new Uint8Array(40)),
      receiver.channel.receive(frames[1]!)
    ]);
    assert.deepEqual(bad, { ok: false, reason: "forged" });
    assert.deepEqual(next, { ok: false, reason: "poisoned" });
  });

  it("refuses to derive keys from a malformed nonce", async () => {
    await assert.rejects(
      Channel.create({ token, clientNonce: "short", serverNonce, role: "client", transmit: () => {} }),
      TypeError
    );
    await assert.rejects(
      Channel.create({ token, clientNonce, serverNonce: `${serverNonce}=`, role: "server", transmit: () => {} }),
      TypeError
    );
  });

  it("makes nonces of 32 random bytes that it accepts, and rejects other spellings", () => {
    const nonce = newNonce();
    assert.equal(nonce.length, 43);
    assert.equal(isNonce(nonce), true);
    assert.notEqual(newNonce(), nonce);
    assert.equal(isNonce(`${nonce}=`), false);
    assert.equal(isNonce(Buffer.alloc(31).toString("base64url")), false);
    assert.equal(isNonce(Buffer.alloc(33).toString("base64url")), false);
    assert.equal(isNonce(Buffer.alloc(32).toString("base64")), false, "padded standard base64");
  });
});
