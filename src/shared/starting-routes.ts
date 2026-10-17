// What each way into a game says under its name on the home screen. The
// same words as the server's title screen (STARTING_ROUTES in the server's
// src/app/home/QuickTiles.tsx); tests/starting-routes.test.mjs holds the
// two together.
export const STARTING_ROUTES = {
  starter: "A prepared one-evening adventure, heroes included",
  new: "Your own table: its world, its rules, your friends",
  join: "Sit at a friend's table with their invite",
} as const;
