import {LineIndexArray, TriangleIndexArray} from '../data/array_types.g';
import {SegmentVector} from '../data/segment';
import {StructArray} from '../util/struct_array';

/**
 * This function will take any "mesh" and fill in into vertex buffers, breaking it up into multiple drawcalls as needed
 * if too many (\>65535) vertices are used.
 * This function is mainly intended for use with subdivided geometry, since sometimes subdivision might generate
 * more vertices than what fits into 16 bit indices.
 */
export function fillArrays(
    segmentsTriangles: SegmentVector,
    segmentsLines: SegmentVector,
    vertexArray: StructArray,
    triangleIndexArray: TriangleIndexArray,
    lineIndexArray: LineIndexArray,
    flattened: Array<number>,
    triangleIndices: Array<number>,
    lineList: Array<Array<number>>,
    addVertex: (x: number, y: number) => void) {

    const numVertices = flattened.length / 2;

    if (numVertices < SegmentVector.MAX_VERTEX_ARRAY_LENGTH) {
        // The fast path - no segmentation needed
        const triangleSegment = segmentsTriangles.prepareSegment(numVertices, vertexArray, triangleIndexArray);
        const triangleIndex = triangleSegment.vertexLength;

        for (let i = 0; i < triangleIndices.length; i += 3) {
            triangleIndexArray.emplaceBack(
                triangleIndex + triangleIndices[i],
                triangleIndex + triangleIndices[i + 1],
                triangleIndex + triangleIndices[i + 2]);
        }

        triangleSegment.vertexLength += numVertices;
        triangleSegment.primitiveLength += triangleIndices.length / 3;

        let lineIndicesStart;
        let lineSegment;

        if (segmentsLines && lineIndexArray) {
            // Note that segment creation must happen before we add vertices into the vertex buffer
            lineSegment = segmentsLines.prepareSegment(numVertices, vertexArray, lineIndexArray);
            lineIndicesStart = lineSegment.vertexLength;
            lineSegment.vertexLength += numVertices;
        }

        // Add vertices into vertex buffer
        for (let i = 0; i < flattened.length; i += 2) {
            addVertex(flattened[i], flattened[i + 1]);
        }

        if (segmentsLines && lineIndexArray) {
            for (let listIndex = 0; listIndex < lineList.length; listIndex++) {
                const lineIndices = lineList[listIndex];

                for (let i = 1; i < lineIndices.length; i += 2) {
                    lineIndexArray.emplaceBack(
                        lineIndicesStart + lineIndices[i - 1],
                        lineIndicesStart + lineIndices[i]);
                }

                lineSegment.primitiveLength += lineIndices.length / 2;
            }
        }
    } else {
        // Assumption: the incoming triangle indices use vertices in roughly linear order,
        // for example a grid of quads where both vertices and quads are created row by row would satisfy this.
        // Some completely random arbitrary vertex/triangle order would not.
        // Thus, if we encounter a vertex that doesn't fit into MAX_VERTEX_ARRAY_LENGTH,
        // we can just stop appending into the old segment and start a new segment and only append to the new segment,
        // copying vertices that are already present in the old segment into the new segment if needed,
        // because there will not be too many of such vertices.

        // Normally, (out)lines share the same vertex buffer as triangles, but since we need to somehow split it into several drawcalls,
        // it is easier to just consider (out)lines separately and duplicate their vertices.

        fillSegmentsTriangles(segmentsTriangles, vertexArray, triangleIndexArray, flattened, triangleIndices, addVertex);
        if (segmentsLines && lineIndexArray) {
            fillSegmentsLines(segmentsLines, vertexArray, lineIndexArray, flattened, lineList, addVertex);
        }
        // Triangles and lines share vertex buffer, but we increment vertex counts of their segments by different amounts.
        // This can cause incorrect indices to be used if we reuse those segments, so we force the segment vector
        // to create new segments on the next `prepareSegment` call.
        segmentsTriangles.invalidateLast();
        segmentsLines?.invalidateLast();
    }
}

function fillSegmentsTriangles(
    segmentsTriangles: SegmentVector,
    vertexArray: StructArray,
    triangleIndexArray: TriangleIndexArray,
    flattened: Array<number>,
    triangleIndices: Array<number>,
    addVertex: (x: number, y: number) => void
) {
    // Array, or rather a map of [vertex index in the original data] -> index of the latest copy of this vertex in the final vertex buffer.
    const actualVertexIndices: Array<number> = [];
    for (let i = 0; i < flattened.length / 2; i++) {
        actualVertexIndices.push(-1);
    }

    let totalVerticesCreated = 0;

    let currentSegmentCutoff = 0;

    let segment = segmentsTriangles.getOrCreateLatestSegment(vertexArray, triangleIndexArray);

    let baseVertex = segment.vertexLength;

    for (let primitiveEndIndex = 2; primitiveEndIndex < triangleIndices.length; primitiveEndIndex += 3) {
        const i0 = triangleIndices[primitiveEndIndex - 2];
        const i1 = triangleIndices[primitiveEndIndex - 1];
        const i2 = triangleIndices[primitiveEndIndex];

        let i0needsVertexCopy = actualVertexIndices[i0] < currentSegmentCutoff;
        let i1needsVertexCopy = actualVertexIndices[i1] < currentSegmentCutoff;
        let i2needsVertexCopy = actualVertexIndices[i2] < currentSegmentCutoff;

        const vertexCopyCount = (i0needsVertexCopy ? 1 : 0) + (i1needsVertexCopy ? 1 : 0) + (i2needsVertexCopy ? 1 : 0);

        // Will needed vertex copies fit into this segment?
        if (segment.vertexLength + vertexCopyCount > SegmentVector.MAX_VERTEX_ARRAY_LENGTH) {
            // Break up into a new segment if not.
            segment = segmentsTriangles.createNewSegment(vertexArray, triangleIndexArray);
            currentSegmentCutoff = totalVerticesCreated;
            i0needsVertexCopy = true;
            i1needsVertexCopy = true;
            i2needsVertexCopy = true;
            baseVertex = 0;
        }

        let actualIndex0 = -1;
        let actualIndex1 = -1;
        let actualIndex2 = -1;

        if (i0needsVertexCopy) {
            actualIndex0 = totalVerticesCreated;
            addVertex(flattened[i0 * 2], flattened[i0 * 2 + 1]);
            actualVertexIndices[i0] = totalVerticesCreated;
            totalVerticesCreated++;
            segment.vertexLength++;
        } else {
            actualIndex0 = actualVertexIndices[i0];
        }

        if (i1needsVertexCopy) {
            actualIndex1 = totalVerticesCreated;
            addVertex(flattened[i1 * 2], flattened[i1 * 2 + 1]);
            actualVertexIndices[i1] = totalVerticesCreated;
            totalVerticesCreated++;
            segment.vertexLength++;
        } else {
            actualIndex1 = actualVertexIndices[i1];
        }

        if (i2needsVertexCopy) {
            actualIndex2 = totalVerticesCreated;
            addVertex(flattened[i2 * 2], flattened[i2 * 2 + 1]);
            actualVertexIndices[i2] = totalVerticesCreated;
            totalVerticesCreated++;
            segment.vertexLength++;
        } else {
            actualIndex2 = actualVertexIndices[i2];
        }

        triangleIndexArray.emplaceBack(
            baseVertex + actualIndex0 - currentSegmentCutoff,
            baseVertex + actualIndex1 - currentSegmentCutoff,
            baseVertex + actualIndex2 - currentSegmentCutoff
        );

        segment.primitiveLength++;
    }
}

function fillSegmentsLines(
    segmentsLines: SegmentVector,
    vertexArray: StructArray,
    lineIndexArray: LineIndexArray,
    flattened: Array<number>,
    lineList: Array<Array<number>>,
    addVertex: (x: number, y: number) => void
) {
    // Array, or rather a map of [vertex index in the original data] -> index of the latest copy of this vertex in the final vertex buffer.
    const actualVertexIndices: Array<number> = [];
    for (let i = 0; i < flattened.length / 2; i++) {
        actualVertexIndices.push(-1);
    }

    let totalVerticesCreated = 0;

    let currentSegmentCutoff = 0;

    let segment = segmentsLines.getOrCreateLatestSegment(vertexArray, lineIndexArray);

    let baseVertex = segment.vertexLength;

    for (let lineListIndex = 0; lineListIndex < lineList.length; lineListIndex++) {
        const currentLine = lineList[lineListIndex];
        for (let lineVertex = 1; lineVertex < lineList[lineListIndex].length; lineVertex += 2) {
            const i0 = currentLine[lineVertex - 1];
            const i1 = currentLine[lineVertex];

            let i0needsVertexCopy = actualVertexIndices[i0] < currentSegmentCutoff;
            let i1needsVertexCopy = actualVertexIndices[i1] < currentSegmentCutoff;

            const vertexCopyCount = (i0needsVertexCopy ? 1 : 0) + (i1needsVertexCopy ? 1 : 0);

            // Will needed vertex copies fit into this segment?
            if (segment.vertexLength + vertexCopyCount > SegmentVector.MAX_VERTEX_ARRAY_LENGTH) {
                // Break up into a new segment if not.
                segment = segmentsLines.createNewSegment(vertexArray, lineIndexArray);
                currentSegmentCutoff = totalVerticesCreated;
                i0needsVertexCopy = true;
                i1needsVertexCopy = true;
                baseVertex = 0;
            }

            let actualIndex0 = -1;
            let actualIndex1 = -1;

            if (i0needsVertexCopy) {
                actualIndex0 = totalVerticesCreated;
                addVertex(flattened[i0 * 2], flattened[i0 * 2 + 1]);
                actualVertexIndices[i0] = totalVerticesCreated;
                totalVerticesCreated++;
                segment.vertexLength++;
            } else {
                actualIndex0 = actualVertexIndices[i0];
            }

            if (i1needsVertexCopy) {
                actualIndex1 = totalVerticesCreated;
                addVertex(flattened[i1 * 2], flattened[i1 * 2 + 1]);
                actualVertexIndices[i1] = totalVerticesCreated;
                totalVerticesCreated++;
                segment.vertexLength++;
            } else {
                actualIndex1 = actualVertexIndices[i1];
            }

            lineIndexArray.emplaceBack(
                baseVertex + actualIndex0 - currentSegmentCutoff,
                baseVertex + actualIndex1 - currentSegmentCutoff
            );

            segment.primitiveLength++;
        }
    }
}