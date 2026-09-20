# Chrome Web Store listing

## Product details

**Name:** Xbox Input Bridge

**Summary:** Use keyboard and mouse as a customizable virtual controller for Xbox Cloud Gaming in Chrome.

**Category:** Tools

**Language:** English, with bundled Spanish, Brazilian Portuguese, and Hindi UI translations.

## Detailed description

Xbox Input Bridge maps keyboard and mouse controls to a virtual standard gamepad inside Xbox Cloud Gaming.

- PC-style W/A/S/D movement and mouse aiming
- D-pad menu navigation with the arrow keys
- Editable keyboard and mouse mappings
- Separate hip and ADS sensitivity, response curves, smoothing, and deadzones
- Local per-game profiles and conservative automatic profile selection
- Fullscreen activation and quick profile controls
- Accessible onboarding, high contrast, reduced-motion support, and keyboard navigation
- Local-only diagnostics with optional persistence

Capture starts only after an explicit user action and stops on focus loss, navigation, pointer-lock loss, or watchdog timeout. Profiles and diagnostics stay on the device. The extension contains no ads, analytics, remote code, or external network client.

This extension is not affiliated with, endorsed by, or sponsored by Microsoft or Xbox. Xbox is a trademark of the Microsoft group of companies.

## Privacy tab

**Single purpose:** Enable keyboard and mouse users to control Xbox Cloud Gaming through a customizable page-local virtual gamepad.

**Permission justification — `storage`:** Stores controller profiles, onboarding preferences, optional aggregate diagnostics, and explicit game/profile associations locally on the user's device.

**Permission justification — `activeTab`:** Allows activation initiated by the user for the current Xbox Cloud Gaming tab.

**Host permission justification — `https://www.xbox.com/*`:** Injects the page-local virtual Gamepad API bridge only on explicitly matched Xbox Cloud Gaming play routes. Runtime checks reject unrelated routes.

**Remote code:** No.

**Data use declarations:** The extension handles keyboard and mouse input transiently to provide its single purpose. Raw input is not stored, transmitted, sold, or used for advertising, analytics, credit, or lending. Settings and optional bounded aggregate diagnostics remain in `chrome.storage.local`.

**Privacy policy:** https://github.com/karma200020/xbox-emulator/blob/main/docs/privacy.md

## Reviewer instructions

1. Install the extension and open `https://www.xbox.com/en-US/play`.
2. Open the extension popup and choose browser gamepad mode.
3. Start capture from the page prompt or press Ctrl+Alt+G.
4. Confirm that W/A/S/D control the left stick, arrow keys control the D-pad, Space controls A, and mouse movement controls the right stick.
5. Press Ctrl+Alt+G again or leave the page to verify immediate neutralization.

No reviewer credentials are supplied because game streaming requires the reviewer's own eligible Microsoft/Xbox account. The public play route, options editor, onboarding, self-tests, and activation lifecycle can be reviewed without credentials.

## Required upload assets

- `small-promo-440x280.png`
- `options-screenshot-1280x800.png`
- Package ZIP generated in `release\`
