import request from "supertest";
import { createApp } from "../../app.js";
import { db } from "../../db/client.js";
import { societies } from "../../db/schema.js";
import {
  createUser,
  grantPermissions,
  TEST_SOCIETY_ID,
} from "../../test/helpers.js";
import { signAccessToken } from "../auth/tokens.js";

const OTHER_SOCIETY_ID = "33333333-3333-4333-8333-333333333333";
const app = createApp();

let auth: string;

async function tokenFor(user: {
  id: string;
  role: "ADMIN" | "RESIDENT" | "GUARD";
}) {
  return `Bearer ${await signAccessToken({ userId: user.id, sessionId: "s1", role: user.role, societyId: TEST_SOCIETY_ID })}`;
}

const api = {
  get: (path: string, token = auth) =>
    request(app).get(`/api/v1${path}`).set("Authorization", token),
  post: (path: string, body: object, token = auth) =>
    request(app).post(`/api/v1${path}`).set("Authorization", token).send(body),
};

const logs = (query = "") =>
  api.get(`/societies/${TEST_SOCIETY_ID}/audit-logs${query}`);

beforeEach(async () => {
  const admin = await createUser({
    phone: "9000000001",
    email: null,
    name: "Anita Rao",
    role: "ADMIN",
  });
  await grantPermissions(admin.id, ["AUDIT_VIEW", "SOCIETY_MANAGE"]);
  auth = await tokenFor(admin);
});

it("needs AUDIT_VIEW and refuses another society’s trail", async () => {
  const resident = await createUser({ phone: "9000000003", email: null });
  await db.insert(societies).values({ id: OTHER_SOCIETY_ID, name: "Other" });

  expect(
    (await request(app).get(`/api/v1/societies/${TEST_SOCIETY_ID}/audit-logs`))
      .status,
  ).toBe(401);
  expect((await logs()).status).toBe(200);
  expect(
    (
      await api.get(
        `/societies/${TEST_SOCIETY_ID}/audit-logs`,
        await tokenFor(resident),
      )
    ).status,
  ).toBe(403);
  expect(
    (await api.get(`/societies/${OTHER_SOCIETY_ID}/audit-logs`)).status,
  ).toBe(403);
});

it("shows who did what, newest first, filtered by event and by user", async () => {
  await api.post(`/societies/${TEST_SOCIETY_ID}/blocks`, { name: "A" });
  await api.post(`/societies/${TEST_SOCIETY_ID}/gates`, { name: "Main gate" });

  const all = await logs();

  expect(all.body.data[0]).toMatchObject({
    eventType: "GATE_CREATED",
    actor: { name: "Anita Rao" },
  });
  expect((await logs("?event=BLOCK_CREATED")).body.data).toHaveLength(1);
  expect((await logs("?user=Anita")).body.data.length).toBeGreaterThan(1);
  expect((await logs("?user=nobody")).body.data).toHaveLength(0);
});

it("records a refused request, so a denial can be investigated", async () => {
  const outsider = await createUser({
    phone: "9000000004",
    email: null,
    role: "ADMIN",
  });
  await grantPermissions(outsider.id, ["AUDIT_VIEW"]);

  await api.post(
    `/societies/${TEST_SOCIETY_ID}/blocks`,
    { name: "A" },
    await tokenFor(outsider),
  );

  const denied = await logs("?event=AUTHORIZATION_DENIED");
  expect(denied.body.data[0]).toMatchObject({
    actor: { phone: "9000000004" },
    metadata: { code: "PERMISSION_DENIED", permission: "SOCIETY_MANAGE" },
  });
});
