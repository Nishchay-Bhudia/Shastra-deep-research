import { jwtVerify } from "jose";

export const SESSION_COOKIE_NAME = "shastra_session";

export async function isValidSession(token: string, secret: string) {
  try {
    await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ["HS256"],
      issuer: "shastra-deep-research",
      audience: "shastra-app",
    });
    return true;
  } catch {
    return false;
  }
}
