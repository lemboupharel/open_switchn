import { fixtureIdentity, fixtureTransport } from "./fixture.js";

const send = fixtureTransport();
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.origin === "https://identitytoolkit.googleapis.com") return fixtureIdentity(url, init);
  return send(url, init);
};
