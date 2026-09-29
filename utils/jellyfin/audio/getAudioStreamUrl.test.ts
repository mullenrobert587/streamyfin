import { describe, expect, mock, test } from "bun:test";
import { stubReactNative } from "@/test-utils/reactNative";

// Stub react-native at the module boundary — pulled in transitively via the
// track player device profile. bun:test cannot load React Native itself.
stubReactNative();
mock.module("expo", () => ({
  // codecSupport probes the native MPV module; under bun:test there is none.
  requireOptionalNativeModule: () => null,
}));

const { getAudioStreamUrl } = await import("./getAudioStreamUrl");
const { makeApi } = await import("@/test-utils/jellyfinApi");
const { default: trackPlayerProfile } = await import(
  "@/utils/profiles/trackplayer"
);

describe("getAudioStreamUrl", () => {
  test("direct stream URL authenticates with ApiKey", async () => {
    const api = makeApi({
      PlaySessionId: "session-1",
      MediaSources: [{ Id: "media-1", Container: "flac" }],
    });

    const result = await getAudioStreamUrl(api, "user-1", "item-1");

    const url = new URL(result!.url);
    expect(url.searchParams.get("ApiKey")).toBe("SECRET_TOKEN");
  });

  test("posts the complete typed playback request through the SDK with proxy and SDK auth headers", async () => {
    const api = makeApi();
    api.update({ basePath: `${api.basePath}/jellyfin` });
    api.axiosInstance.defaults.headers.common["X-Proxy-Token"] = "proxy-token";
    api.mock.onPost(`${api.basePath}/Items/item-1/PlaybackInfo`).reply(200, {
      PlaySessionId: "session-1",
      MediaSources: [{ Id: "media-1", Container: "flac" }],
    });

    const result = await getAudioStreamUrl(api, "user-1", "item-1");

    expect(result).not.toBeNull();
    expect(api.mock.history).toHaveLength(1);
    const request = api.mock.history.post[0];
    expect(request.url).toBe(`${api.basePath}/Items/item-1/PlaybackInfo`);
    expect(JSON.parse(request.data)).toEqual({
      UserId: "user-1",
      DeviceProfile: trackPlayerProfile,
      StartTimeTicks: 0,
      isPlayback: true,
      AutoOpenLiveStream: true,
    });
    expect(request.headers?.["Content-Type"]).toBe("application/json");
    expect(request.headers?.Authorization).toContain('Token="SECRET_TOKEN"');
    expect(request.headers?.["X-Proxy-Token"]).toBe("proxy-token");
  });

  test("direct native URLs preserve base paths, media source selection and encoded credentials without fetching audio", async () => {
    const mediaSource = { Id: "alternate-media", Container: "flac" };
    const api = makeApi({
      PlaySessionId: "session-1",
      MediaSources: [mediaSource],
    });
    api.update({
      basePath: `${api.basePath}/jellyfin`,
      accessToken: "TOKEN /+&?",
    });

    const result = await getAudioStreamUrl(api, "user-1", "item-1");

    const url = new URL(result!.url);
    expect(url.pathname).toBe("/jellyfin/Audio/item-1/stream");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      static: "true",
      container: "flac",
      mediaSourceId: "alternate-media",
      deviceId: "device-1",
      ApiKey: "TOKEN /+&?",
      userId: "user-1",
    });
    expect(result?.sessionId).toBe("session-1");
    expect(result?.mediaSource).toEqual(mediaSource);
    expect(result?.isTranscoding).toBeFalse();
    expect(api.mock.history).toHaveLength(1);
  });

  test("transcoded native URLs retain the exact negotiated path and query", async () => {
    const mediaSource = {
      Id: "media-1",
      TranscodingUrl:
        "/Audio/media-1/stream.mp3?PlaySessionId=session-1&ApiKey=server%2Btoken&StartTimeTicks=0",
    };
    const api = makeApi({
      PlaySessionId: "session-1",
      MediaSources: [mediaSource],
    });
    api.update({ basePath: `${api.basePath}/jellyfin` });

    const result = await getAudioStreamUrl(api, "user-1", "item-1");

    expect(result).toEqual({
      url: `${api.basePath}${mediaSource.TranscodingUrl}`,
      sessionId: "session-1",
      mediaSource,
      isTranscoding: true,
    });
    expect(api.mock.history).toHaveLength(1);
  });

  test("missing media sources retain the existing direct mp3 fallback", async () => {
    const api = makeApi({});

    const result = await getAudioStreamUrl(api, "user-1", "item-1");

    const url = new URL(result!.url);
    expect(url.searchParams.get("container")).toBe("mp3");
    expect(url.searchParams.get("mediaSourceId")).toBe("");
    expect(result?.sessionId).toBeNull();
    expect(result?.mediaSource).toBeNull();
    expect(result?.isTranscoding).toBeFalse();
  });

  test("negotiation errors still return null", async () => {
    const api = makeApi();
    api.mock.onPost(`${api.basePath}/Items/item-1/PlaybackInfo`).reply(503);

    expect(await getAudioStreamUrl(api, "user-1", "item-1")).toBeNull();
  });
});
