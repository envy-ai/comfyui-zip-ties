import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sourcePath = new URL('../web/zip_ties.js', import.meta.url);
let source = await readFile(sourcePath, 'utf8');
source = source.replace(
  /^import \{ app \} from .*;$/m,
  "const app = { extensionManager: { setting: { get: () => 'Rounded grid' } }, registerExtension() {} };",
);
source += '\nexport { gridRoute, roundedGridPath, state, DIR };\n';
globalThis.window = { LiteGraph: { CANVAS_GRID_SIZE: 10 } };
const extension = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function assertOrthogonal(points, label) {
  for (const point of points) assert.ok(point.every(Number.isFinite), `${label}: route points are finite`);
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    assert.ok(Math.abs(dx) < 1e-6 || Math.abs(dy) < 1e-6, `${label}: leg ${i - 1} is axis aligned`);
  }
  for (let i = 2; i < points.length; i++) {
    const ax = points[i - 1][0] - points[i - 2][0];
    const ay = points[i - 1][1] - points[i - 2][1];
    const bx = points[i][0] - points[i - 1][0];
    const by = points[i][1] - points[i - 1][1];
    assert.ok(ax * bx + ay * by >= -1e-6, `${label}: adjacent collinear legs do not reverse`);
  }
}

function assertPortTangents(points, sd, ed, label) {
  const direction = new Map([
    [extension.DIR.UP, [0, -1]],
    [extension.DIR.DOWN, [0, 1]],
    [extension.DIR.LEFT, [-1, 0]],
    [extension.DIR.RIGHT, [1, 0]],
  ]);
  const first = points.slice(1).find(point => point[0] !== points[0][0] || point[1] !== points[0][1]);
  const lastIndex = points.length - 1;
  let last = lastIndex;
  while (last > 0 && points[last][0] === points[last - 1][0] && points[last][1] === points[last - 1][1]) last--;
  if (first) {
    const [dx, dy] = [first[0] - points[0][0], first[1] - points[0][1]];
    const [tx, ty] = direction.get(sd);
    assert.ok(dx * tx + dy * ty > 0, `${label}: first leg follows its output port`);
  }
  if (last > 0) {
    const [dx, dy] = [points[last][0] - points[last - 1][0], points[last][1] - points[last - 1][1]];
    const [tx, ty] = direction.get(ed);
    assert.ok(dx * -tx + dy * -ty > 0, `${label}: last leg enters against its input port direction`);
  }
}

function route(a, b, sd, ed) {
  extension.state.index.clear();
  return extension.gridRoute({ connections_width: 3 }, 1, { a, b, sd, ed });
}

test('grid routes preserve exact endpoints for every port direction pair, including close and reversed ends', () => {
  const dirs = [extension.DIR.UP, extension.DIR.DOWN, extension.DIR.LEFT, extension.DIR.RIGHT];
  const ends = [
    [[0, 0], [18, -100]],
    [[1, 1], [3, 3]],
    [[0, 0], [20, 0]],
    [[100, 70], [10, 10]],
    [[40, 40], [40, 40]],
  ];
  for (const [a, b] of ends) {
    for (const sd of dirs) {
      for (const ed of dirs) {
        const points = route(a, b, sd, ed);
        assert.deepEqual(points[0], a);
        assert.deepEqual(points.at(-1), b);
        assertOrthogonal(points, `${a}/${b}, ${sd}/${ed}`);
        assertPortTangents(points, sd, ed, `${a}/${b}, ${sd}/${ed}`);
      }
    }
  }
});

test('two spaced ties on one wire keep parallel members on distinct orthogonal lanes', () => {
  const links = [1, 2];
  const ties = [
    { pos: [30, 0], angle: 0, links },
    { pos: [80, 35], angle: 0, links },
  ];
  const members = links.map(key => {
    extension.state.index.set(key, ties);
    return extension.gridRoute({ connections_width: 3 }, key, {
      a: [0, 0], b: [120, 40], sd: extension.DIR.RIGHT, ed: extension.DIR.LEFT,
    });
  });
  for (let i = 0; i < members.length; i++) assertOrthogonal(members[i], `member ${links[i]}`);
  const crossingAt = y => members.map(points => {
    for (let i = 1; i < points.length; i++) {
      const [a, b] = [points[i - 1], points[i]];
      if (Math.abs(a[0] - b[0]) < 1e-6 && Math.min(a[1], b[1]) < y && Math.max(a[1], b[1]) > y) return a[0];
    }
    return null;
  });
  const lanes = crossingAt(17.5);
  assert.ok(lanes.every(Number.isFinite), 'both routes cross the space between the ties');
  assert.notEqual(lanes[0], lanes[1], 'parallel members use separate trunk lanes between ties');
});

test('wide tied bundles route every strand without diagonal legs or U-turns', () => {
  const links = Array.from({ length: 20 }, (_, i) => i + 1);
  const tie = { pos: [80, 2], angle: Math.PI / 2, links };
  for (const key of links) {
    extension.state.index.set(key, [tie]);
    const points = extension.gridRoute({ connections_width: 3 }, key, {
      a: [0, 0], b: [100, 4], sd: extension.DIR.RIGHT, ed: extension.DIR.LEFT,
    });
    assert.deepEqual(points[0], [0, 0]);
    assert.deepEqual(points.at(-1), [100, 4]);
    assertOrthogonal(points, `20-strand member ${key}`);
  }
});

test('rounded path emits quadratic corners along the same route geometry', () => {
  const commands = [];
  const path = {
    moveTo: (...p) => commands.push(['moveTo', ...p]),
    lineTo: (...p) => commands.push(['lineTo', ...p]),
    quadraticCurveTo: (...p) => commands.push(['quadraticCurveTo', ...p]),
  };
  const points = [[0, 0], [50, 0], [50, 60], [100, 60]];
  const traced = extension.roundedGridPath(path, points);
  assert.ok(commands.some(command => command[0] === 'quadraticCurveTo'));
  assert.deepEqual(traced[0], points[0]);
  assert.deepEqual(traced.at(-1), points.at(-1));
});
