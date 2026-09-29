import { describe, expect, test } from "bun:test";
import { Jellyfin } from "@jellyfin/sdk";
import { AUTHORIZATION_HEADER } from "@jellyfin/sdk/lib/constants";
import type { AuthenticationResult } from "@jellyfin/sdk/lib/generated-client/models";
import { getAuthenticationApi } from "@jellyfin/sdk/lib/utils/api/authentication-api";
import { getSessionApi } from "@jellyfin/sdk/lib/utils/api/session-api";
import { getSystemApi } from "@jellyfin/sdk/lib/utils/api/system-api";
import { getUserApi } from "@jellyfin/sdk/lib/utils/api/user-api";
import axios, {
  type AxiosInstance,
  type InternalAxiosRequestConfig,
} from "axios";
import MockAdapter from "axios-mock-adapter";
import {
  setJellyfinHeaders,
  stubCustomHeaders,
} from "@/test-utils/customHeaders";

stubCustomHeaders();

const { createApiWithCustomHeaders, createAuthenticatedApi } = await import(
  "./createApi"
);

const SERVER = "https://jellyfin.example";

/**
 * The real SDK, not a double: the argument this wrapper cares about is the
 * third one of `Jellyfin.createApi(basePath, accessToken?, axiosInstance?)`,
 * and a fake that hard-codes that position would keep passing after an SDK bump
 * moved it — while `Api` quietly fell back to `axiosInstance = globalAxios` and
 * put every interceptor back on the shared instance.
 */
const jellyfin = () =>
  new Jellyfin({
    clientInfo: { name: "streamyfin-tests", version: "0.0.0" },
    deviceInfo: { name: "test-device", id: "device-1" },
  });

describe("SDK authentication transport", () => {
  const authentication: AuthenticationResult = {
    AccessToken: "new-token",
    User: { Id: "user-1", Name: "Alex" },
  };

  test("password authentication uses the SDK payload, proxy headers and a fresh published client", async () => {
    setJellyfinHeaders({ "CF-Access-Client-Secret": "proxy-secret" }, SERVER);
    const sdk = jellyfin();
    const activeApi = createApiWithCustomHeaders(sdk, SERVER, "old-token");
    const loginApi = createApiWithCustomHeaders(sdk, SERVER);
    const transport = new MockAdapter(loginApi.axiosInstance, {
      onNoMatch: "throwException",
    });
    transport
      .onPost(`${SERVER}/Users/AuthenticateByName`, {
        Username: "Alex",
        Pw: "password",
      })
      .reply(200, authentication);

    const response = await getAuthenticationApi(
      loginApi,
    ).authenticateUserByName({
      authenticateUserByName: { Username: "Alex", Pw: "password" },
    });
    const published = createAuthenticatedApi(sdk, SERVER, response.data);

    // SDK 1.0 mutates its input, but an isolated login cannot change the
    // currently published session or its unauthorized-response interceptor.
    expect(loginApi.accessToken).toBe("new-token");
    expect(activeApi.accessToken).toBe("old-token");
    expect(published.api).not.toBe(loginApi);
    expect(published.api.axiosInstance).not.toBe(loginApi.axiosInstance);
    expect(published.api.accessToken).toBe("new-token");
    expect(published.userId).toBe("user-1");

    const request = transport.history.post[0];
    expect(request.headers?.["CF-Access-Client-Secret"]).toBe("proxy-secret");
    expect(request.headers?.[AUTHORIZATION_HEADER]).toContain(
      'Client="streamyfin-tests"',
    );
    expect(request.headers?.[AUTHORIZATION_HEADER]).toContain(
      'DeviceId="device-1"',
    );
    expect(request.headers?.[AUTHORIZATION_HEADER]).not.toContain(
      'Token="old-token"',
    );

    const sent = captureRequests(published.api.axiosInstance);
    await getUserApi(published.api).getCurrentUser();
    expect(sent[0].url).toBe(`${SERVER}/Users/Me`);
    expect(sent[0].headers.get(AUTHORIZATION_HEADER)).toContain(
      'Token="new-token"',
    );
    expect(sent[0].headers.get("CF-Access-Client-Secret")).toBe("proxy-secret");
  });

  test("Quick Connect uses SDK routes, encodes the secret, and updates only its login client", async () => {
    setJellyfinHeaders({ "CF-Access-Client-Id": "proxy-id" }, SERVER);
    const api = createApiWithCustomHeaders(jellyfin(), SERVER);
    const transport = new MockAdapter(api.axiosInstance, {
      onNoMatch: "throwException",
    });
    const secret = "secret+/=&";
    transport.onPost(`${SERVER}/QuickConnect/Initiate`).reply(200, {
      Code: "123456",
      Secret: secret,
    });
    transport
      .onGet(`${SERVER}/QuickConnect/Connect?secret=secret%2B%2F%3D%26`)
      .reply(200, {
        Authenticated: true,
      });
    transport
      .onPost(`${SERVER}/Users/AuthenticateWithQuickConnect`, {
        Secret: secret,
      })
      .reply(200, authentication);

    const initiated = await getAuthenticationApi(api).initiateQuickConnect();
    expect(initiated.data.Code).toBe("123456");
    const state = await getAuthenticationApi(api).getQuickConnectState({
      secret,
    });
    expect(state.data.Authenticated).toBe(true);
    await getAuthenticationApi(api).authenticateWithQuickConnect({
      quickConnectDto: { Secret: secret },
    });

    expect(api.accessToken).toBe("new-token");
    for (const request of transport.history) {
      expect(request.headers?.["CF-Access-Client-Id"]).toBe("proxy-id");
      expect(request.headers?.[AUTHORIZATION_HEADER]).toContain(
        'Device="test-device"',
      );
    }
  });

  test.each([401, 403])(
    "failed authentication (%s) does not mutate the token",
    async (status) => {
      const api = createApiWithCustomHeaders(
        jellyfin(),
        SERVER,
        "existing-token",
      );
      const transport = new MockAdapter(api.axiosInstance);
      transport.onPost(`${SERVER}/Users/AuthenticateByName`).reply(status);

      await expect(
        getAuthenticationApi(api).authenticateUserByName({
          authenticateUserByName: { Username: "Alex", Pw: "wrong" },
        }),
      ).rejects.toMatchObject({ response: { status } });

      expect(api.accessToken).toBe("existing-token");
    },
  );

  test.each([
    {},
    { AccessToken: "token" },
    { AccessToken: "token", User: {} },
    { AccessToken: "", User: { Id: "user-1" } },
    { AccessToken: null, User: { Id: "user-1" } },
  ] satisfies AuthenticationResult[])(
    "does not publish an incomplete authentication response %j",
    (result) => {
      expect(() => createAuthenticatedApi(jellyfin(), SERVER, result)).toThrow(
        "Jellyfin returned an incomplete authentication response",
      );
    },
  );

  test("session logout sends the current token and proxy headers, then clears the SDK token", async () => {
    setJellyfinHeaders({ "CF-Access-Client-Id": "proxy-id" }, SERVER);
    const api = createApiWithCustomHeaders(
      jellyfin(),
      SERVER,
      "existing-token",
    );
    const transport = new MockAdapter(api.axiosInstance, {
      onNoMatch: "throwException",
    });
    transport.onPost(`${SERVER}/Sessions/Logout`).reply(204);

    await getSessionApi(api).reportSessionEnded();

    const request = transport.history.post[0];
    expect(request.headers?.[AUTHORIZATION_HEADER]).toContain(
      'Token="existing-token"',
    );
    expect(request.headers?.["CF-Access-Client-Id"]).toBe("proxy-id");
    expect(api.accessToken).toBe("");
  });
});

/**
 * How many *live* request interceptors sit on an instance, which axios does not
 * expose. `eject` nulls its slot in place rather than splicing, so the raw
 * length would count interceptors that have already been removed.
 */
const requestInterceptorCount = (instance: AxiosInstance): number =>
  (
    instance.interceptors.request as unknown as { handlers: unknown[] }
  ).handlers.filter(Boolean).length;

/** Answers every request without a network, and keeps what was about to be sent. */
const captureRequests = (instance: AxiosInstance) => {
  const sent: InternalAxiosRequestConfig[] = [];
  instance.defaults.adapter = async (config) => {
    sent.push(config);
    return { data: null, status: 200, statusText: "OK", headers: {}, config };
  };
  return sent;
};

/** The headers one request went out with. */
const headersOf = async (
  url: string,
  config?: { baseURL?: string },
  serverUrl = SERVER,
) => {
  setJellyfinHeaders({ "cf-access-client-id": "abc" }, serverUrl);
  const api = createApiWithCustomHeaders(jellyfin(), serverUrl);
  const sent = captureRequests(api.axiosInstance);

  await api.axiosInstance.get(url, config);

  expect(sent).toHaveLength(1);
  return sent[0].headers;
};

describe("createApiWithCustomHeaders", () => {
  test("gives each api an axios instance of its own", () => {
    // Everything attached to the global instance would otherwise watch every
    // bare axios call in the app: a 401 from a third-party integration reached
    // the session-expiry interceptor and signed the user out of Jellyfin. And
    // because the header interceptor is never ejected, a shared instance
    // collected another one on every login and every server switch.
    const sdk = jellyfin();

    const first = createApiWithCustomHeaders(sdk, "https://one.example");
    const second = createApiWithCustomHeaders(sdk, "https://two.example");

    expect(first.axiosInstance).not.toBe(axios);
    expect(first.axiosInstance).not.toBe(second.axiosInstance);
  });

  test("adds nothing to the global instance", () => {
    const before = requestInterceptorCount(axios);

    createApiWithCustomHeaders(jellyfin(), SERVER);
    createApiWithCustomHeaders(jellyfin(), SERVER);

    expect(requestInterceptorCount(axios)).toBe(before);
  });

  test("attaches the configured proxy auth headers", async () => {
    // The whole reason this wrapper exists. Moving off the global instance must
    // not cost a Cloudflare Access or Pangolin user their headers.
    //
    // Driven through a real SDK operation rather than a hand-written url: the
    // SDK prepends `basePath` when the instance has no `baseURL`, so every
    // request it makes is absolute, and a spec that asks for a relative path
    // returns before the guard it means to be covering.
    setJellyfinHeaders({ "cf-access-client-id": "abc" }, SERVER);
    const api = createApiWithCustomHeaders(jellyfin(), SERVER);
    const sent = captureRequests(api.axiosInstance);

    await getSystemApi(api).getPublicSystemInfo();

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`${SERVER}/System/Info/Public`);
    expect(sent[0].headers.get("cf-access-client-id")).toBe("abc");
  });

  test("looks the headers up under the server it was created for", async () => {
    // Headers are saved per server, so passing the wrong key here returns none
    // at all — which reads to the user as the gateway rejecting every request.
    setJellyfinHeaders(
      { "cf-access-client-id": "abc" },
      "https://other.example",
    );
    const api = createApiWithCustomHeaders(jellyfin(), SERVER);
    const sent = captureRequests(api.axiosInstance);

    // Absolute, so the guard lets it through and what is left under test is the
    // lookup key rather than the destination check.
    await api.axiosInstance.get(`${SERVER}/System/Info/Public`);

    expect(sent[0].headers.get("cf-access-client-id")).toBeUndefined();
  });

  test("does not send them to a url it cannot place", async () => {
    // Relative with no base: nothing says where this lands, and an
    // unverifiable destination does not get the credentials.
    const headers = await headersOf("/System/Info/Public");

    expect(headers.get("cf-access-client-id")).toBeUndefined();
  });

  test("does not send the headers to a third-party host", async () => {
    // The sessions screen used this instance for a geo-IP lookup, so Cloudflare
    // Access credentials went to freeipapi.com on every visit for over a year.
    const headers = await headersOf("https://freeipapi.com/api/json/1.2.3.4");

    expect(headers.get("cf-access-client-id")).toBeUndefined();
  });

  test("does not send them to a third-party base url either", async () => {
    // Being relative is not what makes a request safe: the base it resolves
    // against is per request, so a caller can point one anywhere.
    const headers = await headersOf("/api/json/1.2.3.4", {
      baseURL: "https://freeipapi.com",
    });

    expect(headers.get("cf-access-client-id")).toBeUndefined();
  });

  test("still sends them to an absolute url on the server", async () => {
    // Guarding absolute URLs must not cost the callers that build a full URL
    // against the server themselves.
    const headers = await headersOf(`${SERVER}/Items/1/Images/Primary`);

    expect(headers.get("cf-access-client-id")).toBe("abc");
  });

  test("still sends them to a relative url on the server's base", async () => {
    const headers = await headersOf("/Items/1/Images/Primary", {
      baseURL: SERVER,
    });

    expect(headers.get("cf-access-client-id")).toBe("abc");
  });
});
