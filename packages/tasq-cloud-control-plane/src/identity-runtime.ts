import { systemClock } from "@tasq-run/schema";
import { createReferenceIdentityHandler } from "./reference-identity.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

const issuer = required("TASQ_ID_ISSUER");
const clientId = required("TASQ_ID_CLIENT_ID");
const redirectUri = required("TASQ_ID_REDIRECT_URI");
const postLogoutRedirectUri = required("TASQ_ID_POST_LOGOUT_REDIRECT_URI");
const operatorSubject = required("TASQ_ID_OPERATOR_SUBJECT");
const fetch = createReferenceIdentityHandler({
  issuer,
  clientId,
  clientSecret: required("TASQ_ID_CLIENT_SECRET"),
  redirectUri,
  postLogoutRedirectUri,
  operatorSubject,
  operatorUsername: required("TASQ_ID_OPERATOR_USERNAME"),
  operatorPassword: required("TASQ_ID_OPERATOR_PASSWORD"),
  signingKeyPkcs8: required("TASQ_ID_SIGNING_KEY_PKCS8"),
  clock: systemClock,
});

Bun.serve({
  port: Number(process.env.PORT ?? "8787"),
  fetch,
});
