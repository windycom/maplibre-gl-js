import {SegmentVector} from './segment';

describe('SegmentVector', () => {
    test('constructor', () => {
        expect(new SegmentVector() instanceof SegmentVector).toBeTruthy();
    });

    test('simpleSegment', () => {
        SegmentVector.MAX_VERTEX_ARRAY_LENGTH = 16;
        const segmentVector = SegmentVector.simpleSegment(0, 0, 10, 0);
        expect(segmentVector instanceof SegmentVector).toBeTruthy();
        expect(segmentVector.segments).toHaveLength(1);
        expect(segmentVector.segments[0].vertexLength).toBe(10);
    });
});
