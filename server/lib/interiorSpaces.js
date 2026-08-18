// Enterable-building interiors, shared between farm.js (fetching a room's
// contents) and shop.js (validating what gets placed inside one).
//
// The house is a singleton — there's only ever one farmhouse per farm — so
// it keeps the simple fixed `location = 'indoor'` value it always had.
// Every OTHER enterable building (coop, barn, cow barn) now gets its own
// SEPARATE interior per physical building placed: two chicken coops on the
// same farm are two independent rooms, not one shared coop-shaped room.
// That room's `location` is `indoor:<farm_objects.id>` — unique per building.

const INTERIOR_WIDTH = 6;
const INTERIOR_HEIGHT = 4;
const HOUSE_LOCATION = 'indoor';

// Room size for each enterable building type (besides the house).
const ENTERABLE_BUILDING_DIMENSIONS = {
  chicken_coop: { width: 4, height: 3 },
  cow_barn: { width: 5, height: 3 },
  barn: { width: 4, height: 3 },
  mansion: { width: 15, height: 10 }, // biggest indoor room in the game, matching its big outdoor footprint
};

// Which animal types are allowed to live inside each building type — a
// chicken coop is for chickens, not cows grazing indoors.
const BUILDING_ALLOWED_ANIMALS = {
  chicken_coop: ['chicken'],
  cow_barn: ['cow'],
  barn: ['pig', 'sheep'],
};

function isEnterableBuildingType(itemId) {
  return Object.prototype.hasOwnProperty.call(ENTERABLE_BUILDING_DIMENSIONS, itemId);
}

// Buildings with more than one floor — a staircase placed on any floor
// takes you to the next one up/down. Floor 1 keeps the plain
// `indoor:<buildingId>` location every other building uses; floor 2 (and
// beyond, if ever added) gets `:<floor>` appended.
const BUILDING_FLOOR_COUNT = { mansion: 2 };

function locationForBuilding(buildingObjectId, floor) {
  return floor && floor > 1 ? `indoor:${buildingObjectId}:${floor}` : `indoor:${buildingObjectId}`;
}

// Given a location string, returns the farm_objects.id it refers to, or
// null if this isn't a per-building indoor location (e.g. it's the house,
// or plain 'outdoor'). Matches both floor 1 (`indoor:5`) and any other
// floor (`indoor:5:2`).
function buildingIdFromLocation(location) {
  if (typeof location !== 'string') return null;
  const match = location.match(/^indoor:(\d+)(?::\d+)?$/);
  return match ? parseInt(match[1], 10) : null;
}

// The floor number a location string refers to — 1 for the house, plain
// `indoor:<id>`, or anything without an explicit `:<floor>` suffix.
function floorFromLocation(location) {
  if (typeof location !== 'string') return 1;
  const match = location.match(/^indoor:\d+:(\d+)$/);
  return match ? parseInt(match[1], 10) : 1;
}

module.exports = {
  INTERIOR_WIDTH, INTERIOR_HEIGHT, HOUSE_LOCATION,
  ENTERABLE_BUILDING_DIMENSIONS, BUILDING_ALLOWED_ANIMALS, BUILDING_FLOOR_COUNT,
  isEnterableBuildingType, locationForBuilding, buildingIdFromLocation, floorFromLocation,
};
