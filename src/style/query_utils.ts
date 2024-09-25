import Point from '@mapbox/point-geometry';

export function translateDistance(translate: [number, number]) {
    return Math.sqrt(translate[0] * translate[0] + translate[1] * translate[1]);
}

export function translate(queryGeometry: Array<Point>,
    translate: [number, number],
    translateAnchor: 'viewport' | 'map',
    bearing: number,
    pixelsToTileUnits: number) {
    if (!translate[0] && !translate[1]) {
        return queryGeometry;
    }
    const pt = Point.convert(translate)._mult(pixelsToTileUnits);

    if (translateAnchor === 'viewport') {
        pt._rotate(-bearing);
    }

    const translated = [];
    for (let i = 0; i < queryGeometry.length; i++) {
        const point = queryGeometry[i];
        translated.push(point.sub(pt));
    }
    return translated;
}

export function offsetLine(rings: Array<Array<Point>>, offset: number) {
    const newRings: Array<Array<Point>> = [];
    for (let ringIndex = 0; ringIndex < rings.length; ringIndex++) {
        const ring = rings[ringIndex];
        const newRing: Array<Point> = [];
        for (let index = 0; index < ring.length; index++) {
            const a = ring[index - 1];
            const b = ring[index];
            const c = ring[index + 1];
            const aToB = index === 0 ? new Point(0, 0) : b.sub(a)._unit()._perp();
            const bToC = index === ring.length - 1 ? new Point(0, 0) : c.sub(b)._unit()._perp();
            const extrude = aToB._add(bToC)._unit();

            const cosHalfAngle = extrude.x * bToC.x + extrude.y * bToC.y;
            if (cosHalfAngle !== 0) {
                extrude._mult(1 / cosHalfAngle);
            }

            newRing.push(extrude._mult(offset)._add(b));
        }
        newRings.push(newRing);
    }
    return newRings;
}
