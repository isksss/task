import { describe, expect, it } from "vitest";
import { clearDeviceDataConfirmation, dictionaries, en, getDefaultLocale, ja } from "./i18n";

describe("i18n", () => {
  it("provides the same translation keys in Japanese and English", () => {
    expect(Object.keys(dictionaries.en).sort()).toEqual(Object.keys(ja).sort());
  });

  it("includes the unsent change count in the clear-data warning", () => {
    expect(clearDeviceDataConfirmation(ja, 3)).toContain("3 件");
    expect(clearDeviceDataConfirmation(ja, 3)).toContain("未送信");
    expect(clearDeviceDataConfirmation(en, 3)).toContain("3 unsent changes");
    expect(clearDeviceDataConfirmation(ja, 0)).toBe(ja.confirmClearDeviceData);
  });

  it("chooses the default language from the browser language", () => {
    expect(getDefaultLocale("en-GB")).toBe("en");
    expect(getDefaultLocale("ja-JP")).toBe("ja");
    expect(getDefaultLocale("fr-FR")).toBe("ja");
  });
});
