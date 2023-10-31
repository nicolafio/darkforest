// Patches the Dark Forest client runtime environment to
// include a bunch of handy custom functions and complex
// orders.

module.exports.init = async function init(puppeteerPage) {
  await puppeteerPage.evaluate(runtimeLogic);
};

function runtimeLogic() {
  if (!('dfcli' in window)) window.dfcli = {};
  const DEFAULT_PLANET_INFO_KEYS = ['coords', 'energy', 'silver', 'range', 'owned'];

  // Like current working directory but for planets.
  let cwd = null;

  Object.assign(dfcli, {
    props(object, pattern = null) {
      let props = new Set();
      while (object !== null) {
        for (const name of Object.getOwnPropertyNames(object)) props.add(name);
        object = Object.getPrototypeOf(object);
      }

      props = [...props];

      if (typeof pattern === 'string')
        props = props.filter((p) => p.toLowerCase().includes(pattern.toLowerCase()));
      if (pattern instanceof RegExp) props = props.filter((p) => pattern.test(p));

      return props.join('\n');
    },

    tabulate(keys, objects, spacing = 2) {
      let str = '';
      const maxLengths = new Map(
        keys.map((key) => [key, _.max([key.length, ...objects.map((o) => String(o[key]).length)])])
      );
      for (const k of keys) {
        str += k;
        const l = k.length;
        const n = maxLengths.get(k);
        for (let i = l; i < n + spacing; i++) str += ' ';
      }
      str += '\n';
      for (const o of objects) {
        for (const k of keys) {
          const s = String(o[k]);
          const l = s.length;
          const n = maxLengths.get(k);
          str += s;
          for (let i = l; i < n + spacing; i++) str += ' ';
        }
        str += '\n';
      }
      return str;
    },

    planetInfo(planets = [dfcli.cwd()], keys = DEFAULT_PLANET_INFO_KEYS) {
      if (!(planets instanceof Array)) return dfcli.planetInfo([planets], keys);
      planets = planets.map(dfcli.asPlanet);
      return dfcli.tabulate(
        keys,
        planets.map((p) => ({
          ...p,
          coords: JSON.stringify([p.location.coords.x, p.location.coords.y]),
          energy: Math.floor(p.energy),
          owned: p.owner === df.getAddress() ? '✓' : '',
        }))
      );
    },

    coords(from = dfcli.cwd()) {
      const { x, y } = dfcli.asPlanet(dfcli.get(from)).location.coords;
      return [x, y];
    },

    info(...args) {
      return dfcli.planetInfo(...args);
    },

    asLocationID(planet) {
      // Assuming that it's an ID if you are passing a string.
      if (typeof planet === 'string') return planet;
      return planet.locationId;
    },

    asID(planet) {
      return dfcli.asLocationID(planet);
    },

    asPlanet(planet) {
      if (typeof planet === 'string') return df.getPlanetWithId(planet);
      return planet;
    },

    cwd() {
      if (cwd === null) cwd = dfcli.getMyFirstPlanetID();
      return cwd;
    },

    // Change planet
    cd(info, from = dfcli.cwd()) {
      cwd = dfcli.get(info, from);
    },

    // Gets a planet given info.
    get(info, from = dfcli.cwd()) {
      if (info instanceof Array && info.length === 2) {
        // Dealing with coordinates.
        const [x, y] = info;
        return dfcli.asLocationID(df.getPlanetWithCoords({ x, y }));
      }
      if (typeof info === 'string') {
        // Dealing with an ID.
        return info;
      }
      if (typeof info === 'number') {
        // Dealing with a relative distance.
        return dfcli.asLocationID(
          df.getPlanetsInRange(from).find((planet) => {
            const dist = df.getDist(from, planet.locationId);
            return Math.abs(info - dist) < 0.1;
          })
        );
      }
      return dfcli.asLocationID(from);
    },

    // List planets in range
    ls(from = dfcli.cwd()) {
      const keys = DEFAULT_PLANET_INFO_KEYS.concat(['distance']);
      let planets = df.getPlanetsInRange(from).map((planet) => ({
        ...planet,
        distance: Math.round(df.getDist(from, dfcli.asLocationID(planet)) * 100) / 100,
      }));
      planets = _.sortBy(planets, (planet) => planet.distance);
      return dfcli.info(planets, keys);
    },

    getMyFirstPlanet() {
      return df.getAllOwnedPlanets()[0];
    },

    getMyFirstPlanetID() {
      return dfcli.getMyFirstPlanet().locationId;
    },

    getNearestPlanetID(from = dfcli.cwd()) {
      from = dfcli.get(from);
      return _.minBy(
        df
          .getPlanetsInRange(from)
          .map((planet) => planet.locationId)
          .map((id) => [id, df.getDist(from, id)])
          .filter(([, dist]) => dist > 0),
        ([, dist]) => dist
      )[0];
    },

    getPlanetIDs(planets = df.getAllOwnedPlanets()) {
      return planets.map(dfcli.asLocationID);
    },

    planets(...args) {
      return dfcli.getPlanetIDs(...args);
    },

    getExactEnergy(from = dfcli.cwd()) {
      from = dfcli.get(from);
      return df.getPlanetWithId(from).energy;
    },

    getEnergy(from = dfcli.cwd()) {
      return Math.floor(dfcli.getExactEnergy(from));
    },

    energy(from = dfcli.cwd()) {
      return dfcli.getEnergy(from);
    },

    getAllEnergy(ids = dfcli.getPlanetIDs()) {
      ids = ids.map(dfcli.asLocationID);
      return _.sum(ids.map((id) => this.getEnergy(id)));
    },

    allEnergy(...args) {
      return dfcli.getAllEnergy(...args);
    },

    sendEnergy(to, from = dfcli.cwd(), energy = dfcli.getEnergy(from)) {
      from = dfcli.get(from);
      to = dfcli.get(to);
      return df.move(from, to, energy, 0);
    },

    send(...args) {
      return dfcli.sendEnergy(...args);
    },

    sendAll(to, from = dfcli.getPlanetIDs(), energyFraction = 1) {
      for (const planet of from) {
        const energy = Math.floor(dfcli.energy(planet) * energyFraction);
        if (energy === 0) continue;
        dfcli.send(to, planet, energy);
      }
    },

    sendEnergyToNearestPlanet(from = dfcli.cwd(), energy = dfcli.getEnergy(from)) {
      from = dfcli.get(from);
      const to = dfcli.getNearestPlanetID(from);
      return df.move(from, to, energy, 0);
    },

    println(str) {
      window.DF_CLI_PRINT(str + '\n');
    },

    junk(from = df.getAddress()) {
      return df.getPlayerSpaceJunk(from);
    },

    junkLimit(from = df.getAddress()) {
      return df.getPlayerSpaceJunkLimit(from);
    },

    address() {
      return df.getAddress();
    },
  });
}
