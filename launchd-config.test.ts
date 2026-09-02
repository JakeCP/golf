import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

describe("Mac Mini LaunchAgent configuration", () => {
  const plist = fs.readFileSync(
    path.join(__dirname, "com.jakecp.golf-booking.plist"),
    "utf8"
  );

  it("runs the production wrapper at 06:50", () => {
    expect(plist).toContain("com.jakecp.golf-booking");
    expect(plist).toContain("/Users/golfbot/golf-booker/mac-mini-run.sh");
    expect(plist).toMatch(/<key>Hour<\/key>\s*<integer>6<\/integer>/);
    expect(plist).toMatch(/<key>Minute<\/key>\s*<integer>50<\/integer>/);
  });

  it("sets the cron-equivalent working directory and base environment", () => {
    expect(plist).toContain("/Users/golfbot/golf-booker</string>");
    expect(plist).toContain("/usr/bin:/bin:/usr/sbin:/sbin");
  });
});
