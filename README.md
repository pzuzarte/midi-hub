# MIDI Hub

Routes MIDI between instruments and a keyboard controller, from one page in the browser. It's set up for a Novation Bass Station, Roland AIRA Compact S-1, Waldorf Protein, MPC Sample and MPC One, and works with any USB MIDI device. It's unofficial and not affiliated with any of their makers.

- **Quick routes**: choose which instruments the keyboard plays, which ones the S-1's sequencer plays, and where the clock comes from and goes, with one click each.
- **All routes**: any input to any output, filtered by channel and message type, with channel changes and transposing.
- **Devices**: every connected port, what it is, and the channel each instrument listens on.
- **Monitor**: the messages arriving, for checking what an instrument sends.
- **Setups**: named sets of routes, kept in the browser, with backup and restore to a file.

Routing happens in the page, so it stops when the page is closed.

## Requirements

A current Chrome or Edge on a computer, for Web MIDI.

## Running it

It's a static page with no build step. Serve the folder and open it:

```bash
python3 -m http.server 8777
```

## Tests

```bash
node --test "test/*.test.js"
```
