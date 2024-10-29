import {TileBounds} from './tile_bounds';
import {CanonicalTileID} from './tile_id';

describe('TileBounds', () => {
    test('default', () => {
        const bounds = new TileBounds([-180, -90, 180, 90]);
        expect(bounds.contains(new CanonicalTileID(2, 0, 0))).toBe(true);
        expect(bounds.contains(new CanonicalTileID(2, 1, 1))).toBe(true);
        expect(bounds.contains(new CanonicalTileID(2, 2, 2))).toBe(true);
        expect(bounds.contains(new CanonicalTileID(2, 3, 3))).toBe(true);
    });

    describe('latitude', () => {
        test('is clamped', () => {
            const bounds = new TileBounds([-180, -900, 180, 900]);
            expect(bounds.contains(new CanonicalTileID(2, 0, 0))).toBe(true);
            expect(bounds.contains(new CanonicalTileID(2, 1, 1))).toBe(true);
            expect(bounds.contains(new CanonicalTileID(2, 2, 2))).toBe(true);
            expect(bounds.contains(new CanonicalTileID(2, 3, 3))).toBe(true);
        });

        test('limits extent', () => {
            const bounds = new TileBounds([-180, -45, 180, 45]);
            expect(bounds.contains(new CanonicalTileID(2, 0, 0))).toBe(false);
            expect(bounds.contains(new CanonicalTileID(2, 1, 1))).toBe(true);
            expect(bounds.contains(new CanonicalTileID(2, 2, 2))).toBe(true);
            expect(bounds.contains(new CanonicalTileID(2, 3, 3))).toBe(false);
        });
    });

    describe('longitude with wrapping', () => {
        test('half range', () => {
            const bounds = new TileBounds([0, -90, 180, 90]);
            expect(bounds.contains(new CanonicalTileID(2, 0, 0))).toBe(false);
            expect(bounds.contains(new CanonicalTileID(2, 1, 1))).toBe(false);
            expect(bounds.contains(new CanonicalTileID(2, 2, 2))).toBe(true);
            expect(bounds.contains(new CanonicalTileID(2, 3, 3))).toBe(true);
        });

        test('wrapped positive', () => {
            const bounds = new TileBounds([0, -90, 270, 90]);
            expect(bounds.contains(new CanonicalTileID(2, 0, 0))).toBe(true);
            expect(bounds.contains(new CanonicalTileID(2, 1, 1))).toBe(false);
            expect(bounds.contains(new CanonicalTileID(2, 2, 2))).toBe(true);
            expect(bounds.contains(new CanonicalTileID(2, 3, 3))).toBe(true);
        });

        test('wrapped negative', () => {
            const bounds = new TileBounds([-270, -90, 0, 90]);
            expect(bounds.contains(new CanonicalTileID(2, 0, 0))).toBe(true);
            expect(bounds.contains(new CanonicalTileID(2, 1, 1))).toBe(true);
            expect(bounds.contains(new CanonicalTileID(2, 2, 2))).toBe(false);
            expect(bounds.contains(new CanonicalTileID(2, 3, 3))).toBe(true);
        });
    });
});
