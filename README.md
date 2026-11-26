# Pain-T 1.2.0

Pain-T is a harder fork of Archipelago Paint. You paint a copy of a goal picture in a browser version of MS Paint,
and checks go out as your canvas's similarity to the goal climbs. The canvas grows, the palette deepens and the tools
unlock as items arrive, and auto copy, a painter driven by items, does the slow work over hours.

## What you need

- Archipelago 0.6.6 or newer. Pain-T was tested on 0.6.6 and 0.6.8.
- `paint_hard.apworld`, version 1.2.0, from the
  [Pain-T 1.2.0 release](https://github.com/Zackman6344/jspaint/releases/tag/pain-t-v1.2.0).
- A browser for the client, https://zackman6344.github.io/jspaint/. Chrome, Firefox and Edge are tested.

## Installing the world

1. Copy `paint_hard.apworld` into the `custom_worlds` folder of your Archipelago install. On Windows that is
   `C:\ProgramData\Archipelago\custom_worlds` by default. Keep the file name: a copy renamed by a second download,
   such as `paint_hard (1).apworld`, doesn't load.
2. Close the Launcher and the Options Creator if they are open, then start them again. Archipelago reads its worlds
   when it starts.

Double-clicking an `.apworld` file can install it too. Check afterwards that it landed in `custom_worlds`.

## Making your YAML

### In the Options Creator

Start the Options Creator and click Pain-T in the game list, just above Paint. Each option's tooltip holds its full
text.

- Eight wide sliders have a list beside them with common values: Goal Width, Goal Height, Color Depth Items, Miss
  Margin Step, Overclock Seconds, Overclock Bank Size Step, Timesanity Minutes and Missed Pixel Checks. Pick from the
  list for an exact value such as 4096. **Touching the slider after a pick stores the slider's number instead**, and
  the button then reads Custom.
- In the Goal Image and Goal Image SHA-256 text boxes, press Enter after typing or pasting. Archipelago 0.6.6 keeps a
  value only then; 0.6.8 keeps typed text either way.
- The name takes 1 to 16 characters.
- Export Options saves the YAML.

A value picked from a list is written as text, such as `goal_width: '4096'`, and reads as the number. For a value
neither the list nor the slider gives, open the exported file in a text editor and type it.

### In a text editor

The Launcher's Generate Template Options writes a template for every installed game, `Pain-T.yaml` among them, with
every option, its default and its text. A YAML needs only the options you change:

```yaml
name: YourName
game: Pain-T
Pain-T:
  goal_image: https://raw.githubusercontent.com/you/goals/main/goal.png
  goal_width: 2000
  goal_height: 1500
  goal_image_sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
```

## Setting a goal image

`goal_image: default` plays the bundled picture of your `aspect_ratio`: 800x600, 800x450, 800x800, 600x800 or
450x800. Any other value names a picture of your own. The client takes one that is:

- a PNG. JPEG and WebP are refused;
- at most 4096 pixels on each side. The world accepts sides up to 16,384, and the client refuses any past 4096;
- at an https address whose server lets other sites load it, by sending `Access-Control-Allow-Origin`, or at a path
  inside the client's own site, such as `images/archipelago/800x600.png`.

Set `goal_width` and `goal_height` to the picture's exact size in pixels, both of them. Set `goal_image_sha256` to the
file's SHA-256, 64 hex digits. The client checks the size and the hash as it loads the picture, and refuses one that
doesn't match in a window that names the fault.

**Generation reads no file and no network.** A wrong size, a dead link or a mistyped hash generates without an error,
and the slot then can't load its goal. A seed keeps its YAML's values for its whole life, so check them before the
host generates.

### Where to keep the picture

- GitHub serves files that work: a public repository's file at `https://raw.githubusercontent.com/<user>/<repo>/<branch>/<file>.png`,
  or a GitHub Pages site. Both send `Access-Control-Allow-Origin: *` and serve the PNG byte for byte. GitHub refuses
  files over 100 MB.
- Links that expire, such as Discord attachment links, stop loading once they do.
- A host that re-encodes uploads changes the file, and its hash with it. Download the picture back from its address
  and take the hash of that copy.
- The address takes at most 2,048 characters, with no spaces or backslashes. http and `data:` addresses are refused.

### Taking the size and the hash

The size is in the file's properties: on Windows, right-click, Properties, Details, Dimensions.

| System | Command |
|---|---|
| Windows PowerShell | `Get-FileHash .\goal.png -Algorithm SHA256` |
| Windows command prompt | `certutil -hashfile goal.png SHA256` |
| macOS | `shasum -a 256 goal.png` |
| Linux | `sha256sum goal.png` |

Upper- and lowercase both work; the seed stores the hash in lowercase.

### Transparency and load time

Pixels that aren't fully opaque are drawn onto white, and the score asks for those colors. In the tests, with the
file served from the same PC, a 4096x4096 PNG with no transparency scored within 0.8 s of Connect, and one with
transparency within 2.6 s. The download comes on top: a detailed 4096x4096 PNG is about 50 MB. The browser keeps the
file after its first load, and a reload reads it from there.

### Big goals make big slots

The canvas items follow the goal's size and the canvas steps: a 4096x4096 goal in 5 px steps has about 1,640 canvas
items. With every check family below at its top, such a slot has 26,305 locations, and 8 of them beside 22 slots of
other games took 55 to 62 minutes to generate on a 16-thread PC. With Pain-T alone in a seed, a big goal can fail
Pain-T's own fill check; beside other games it doesn't run.

## The three check families

Perfect Pixels (`perfect_pixel_checks`), Auto Copy Time (`timesanity_minutes`) and Missed Pixels
(`missed_pixel_checks`) add checks beside the similarity checks. All three are off by default.

**The client doesn't send these checks yet.** Items placed on them, yours and other players', wait until it does.
Perfect Pixels checks also need every Progressive Color Depth item in logic, and at `perfect_pixel_items` `useful` and
`any` Archipelago's fill puts many of the multiworld's useful items on them.

## Playing

Open the client, enter the room's address, your slot name and the room password if there is one, and click Connect.

- A big goal shows a progress window as it downloads. A fault shows in a window with Retry, and a click on the goal
  field in the status bar brings that window back.
- A 1.2.0 seed's goal stays fixed: File > Open Goal Image doesn't swap it.
- Your painting saves in the browser as you go. Keep the address with its part after `#`, or keep the tab, to come
  back to the same canvas.
- Firefox with resistFingerprinting, LibreWolf, Tor Browser and some extensions give pages random pixels when they
  read a canvas. Pain-T then sends and saves nothing, and asks you to allow canvas reads for the site and reload.

### DeathLink and TrapLink

With `death_link` on, Undo and Clear Image send a death to every DeathLink player, and a death you receive clears your
canvas and its history. With several Pain-T slots on DeathLink, one Undo in any of them clears all the others. With `trap_link`
on, traps that other TrapLink players receive reach your canvas too.

## When something goes wrong

- **Pain-T isn't in the Options Creator.** `paint_hard.apworld` isn't in `custom_worlds`, or the Options Creator was
  open when it went there. Check the folder and start the Options Creator again.
- **Generation says the Pain-T world loaded as version 0.0.0.** The `.apworld` was zipped by hand or packed again.
  Use the original `paint_hard.apworld`.
- **The log says it did not load `paint_hard.apworld` because its minimum core version is higher.** Update
  Archipelago to 0.6.6 or newer.
- **Generation refuses the YAML.** The message names the option and what to change.
- **Archipelago stops with "No more spots to place".** The fill ran out of room for Pain-T's items. Generate again
  with another seed number, or use bigger canvas steps.
- **A window says the goal's size or SHA-256 doesn't match.** The YAML's `goal_width`, `goal_height` or
  `goal_image_sha256` differs from the file at its address. A generated seed can't change, so the file at the address
  has to be the one the hash was taken from.
- **The goal doesn't load from your address.** Open the address in a browser: it should show the picture alone. A
  page around the picture, a login, an expired link and a server without `Access-Control-Allow-Origin` all fail.

## Credits

Pain-T is built on [Archipelago Paint](https://github.com/MarioManTAW/jspaint) by MarioManTAW, which is built on
[JS Paint](https://jspaint.app) by Isaiah Odhner. The code is under the MIT License in `LICENSE.txt`.
