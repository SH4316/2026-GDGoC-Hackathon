# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=2,<3", "shapely==2.2.0", "trimesh==4.12.2", "pillow>=11,<14"]
# ///
"""Rebuild the architectural shell of the 184132 scan in its local Y-up, metre frame."""
import argparse
from pathlib import Path

import numpy as np
import shapely
import trimesh
from PIL import Image

HERE = Path(__file__).resolve().parent
SCAN = HERE / "Scaniverse_2026_11_20_184132.obj"
OUTPUT = HERE / "reconstructed"

# Measured cross-sections: along-axis, two lateral edges, floor Y, ceiling Y (metres).
# The two passes drift in elevation. Use these heights for local headroom and
# to register observations against a common finished floor at Y=0.
# At a change of width, repeat the along-coordinate to create a square recess.
RUNS = {
    "Cross hall": ("X", [
        (-15.31, -12.96, -10.28, .16, 2.84),
        (-5.25, -12.90, -10.16, .15, 2.82),
        (1.9, -12.96, -10.20, .06, 2.72),
        (11.77, -12.92, -10.20, .01, 2.66),
        (14.70, -12.92, -10.20, .01, 2.66),
    ]),
    "Long east passage": ("Z", [
        (-10.20, 11.77, 13.92, .01, 2.66),
        (0, 11.73, 13.93, -.08, 2.59),
        (10, 11.69, 13.89, -.13, 2.55),
        (19.97, 11.66, 13.84, -.16, 2.53),
    ]),
    "North arm": ("Z", [
        (-23.96, -4.91, -1.54, .28, 2.93),
        (-22.00, -5.03, -1.58, .28, 2.93),
        (-20.00, -5.06, -1.65, .28, 2.93),
        (-18.00, -5.04, -1.74, .27, 2.96),
        (-18.00, -4.60, -1.96, .27, 2.96),
        (-15.35, -4.61, -2.07, .25, 3.00),
        (-15.35, -5.16, -2.07, .25, 3.00),
        (-12.92, -5.20, -2.10, .23, 3.01),
    ]),
    "North side passage": ("X", [
        (-1.61, -22.00, -20.00, .28, 2.93),
        (3.69, -21.95, -19.95, .30, 2.97),
    ]),
    "Central passage": ("Z", [
        (-10.17, -5.54, -3.32, .40, 3.07),
        (0, -5.91, -3.62, .45, 3.12),
        (7.0, -6.16, -3.83, .48, 3.15),
        (16.42, -6.28, -3.54, .53, 3.20),
        (18.70, -6.29, -2.00, .53, 3.21),
    ]),
    "West side passage": ("X", [
        (-10.57, 16.37, 18.61, .54, 3.21),
        (-6.28, 16.42, 18.70, .53, 3.20),
    ]),
    "South bend": ("X", [
        (-6.29, 18.70, 18.70, .53, 3.21),
        (-4.05, 18.70, 20.95, .54, 3.22),
        (-2.00, 18.70, 21.71, .56, 3.25),
        (-.58, 18.79, 22.07, .57, 3.26),
    ]),
    "South hall": ("X", [
        (-.58, 19.74, 22.07, .57, 3.26),
        (2.48, 19.79, 22.12, .59, 3.27),
        (3.91, 19.82, 22.16, .60, 3.28),
        (6.28, 19.88, 22.21, .62, 3.30),
        (8.59, 19.93, 22.25, .63, 3.32),
        (9.48, 19.95, 22.27, .63, 3.33),
        (9.48, 17.70, 22.27, .63, 3.33),
        (11.66, 17.70, 22.32, .63, 3.34),
    ]),
    "South recess 1": ("Z", [
        (22.14, 2.48, 3.91, .60, 3.28),
        (23.60, 2.49, 3.92, .60, 3.28),
    ]),
    "South recess 2": ("Z", [
        (22.23, 6.28, 8.59, .63, 3.31),
        (23.68, 6.25, 8.62, .63, 3.31),
    ]),
}

# The pass along the south hall ends one corridor width west of the east pass.
# Register the turn to the full final section of the east passage. The inset in
# the last two raw south sections is the duplicate end of the return pass.
def joined_runs():
    runs = RUNS.copy()
    _, south = runs["South hall"]
    east_z, inner_x, outer_x, _, _ = runs["Long east passage"][1][-1]
    _, _, outer_z, floor, ceiling = south[-1]
    runs["South hall"] = ("X", south[:-2] + [
        (inner_x, east_z, outer_z, floor, ceiling), (outer_x, east_z, outer_z, floor, ceiling)
    ])
    return runs


COLORS = {
    "Floor": (132, 158, 169), "Ceiling": (226, 229, 223),
    "Walls": (202, 184, 156), "Estimated walls": (207, 191, 167),
}
WALL_LAYERS = {"Walls", "Estimated walls"}


def add_surface(scene, layer, name, triangles, inward):
    points = np.asarray(triangles, dtype=float)
    normals = np.cross(points[:, 1] - points[:, 0], points[:, 2] - points[:, 0])
    facing = normals @ inward
    valid = np.abs(facing) > 1e-9
    points = points[valid].copy()
    reverse = facing[valid] < 0
    points[reverse] = points[reverse, ::-1]
    if not len(points):
        return
    vertices, indices = np.unique(points.reshape(-1, 3), axis=0, return_inverse=True)
    mesh = trimesh.Trimesh(vertices, indices.reshape(-1, 3), process=False)
    material = trimesh.visual.material.PBRMaterial(
        name=layer, baseColorFactor=[*COLORS[layer], 255], metallicFactor=0, roughnessFactor=1,
        doubleSided=layer in WALL_LAYERS,
    )
    mesh.visual = trimesh.visual.TextureVisuals(material=material)
    scene.add_geometry(mesh, node_name=name, geom_name=name, parent_node_name=layer)


def floor_plan(runs):
    strips = []
    for axis, sections in runs.values():
        for a, b in zip(sections, sections[1:]):
            if a[0] == b[0]:
                continue
            corners = [(a[0], a[1]), (a[0], a[2]), (b[0], b[2]), (b[0], b[1])]
            strips.append(shapely.Polygon(corners if axis == "X" else [(v, u) for u, v in corners]))
    plan = shapely.union_all(strips)
    # Surveyed branch mouths miss the adjoining strip by a few centimetres.
    plan = plan.buffer(.06, join_style="mitre").buffer(-.06, join_style="mitre").simplify(.025)
    if plan.geom_type != "Polygon" or len(plan.interiors) != 1:
        raise ValueError("The joined passages must enclose one courtyard.")
    return shapely.orient_polygons(plan.segmentize(4))


def section_heights(points, runs):
    # Interpolate on the nearest sampled centreline. Each shared plan vertex
    # receives the same clearance on both sides of a junction.
    points = np.asarray(points)
    best = np.full(len(points), np.inf)
    heights = np.zeros((len(points), 2))
    for axis, sections in runs.values():
        query = points if axis == "X" else points[:, ::-1]
        for a, b in zip(sections, sections[1:]):
            if a[0] == b[0]:
                continue
            start = np.array([a[0], (a[1] + a[2]) / 2])
            delta = np.array([b[0], (b[1] + b[2]) / 2]) - start
            t = np.clip((query - start) @ delta / (delta @ delta), 0, 1)
            distance = np.sum((query - start - t[:, None] * delta) ** 2, axis=1)
            use = distance < best
            best[use] = distance[use]
            heights[use] = a[3:] + t[use, None] * (np.array(b[3:]) - a[3:])
    return heights


def triangles_2d(shape):
    faces = shapely.get_parts(shapely.constrained_delaunay_triangles(shape))
    return shapely.get_coordinates(faces).reshape(-1, 4, 2)[:, :3]


def passage_surfaces(scene, plan, runs):
    xz = triangles_2d(plan)
    heights = section_heights(xz.reshape(-1, 2), runs).reshape(-1, 3, 2)
    xyz = np.zeros((*xz.shape[:2], 3))
    xyz[:, :, [0, 2]] = xz
    add_surface(scene, "Floor", "Connected floor", xyz, [0, 1, 0])
    xyz[:, :, 1] = heights[:, :, 1] - heights[:, :, 0]
    add_surface(scene, "Ceiling", "Connected ceiling", xyz, [0, -1, 0])


def complete_walls(scene, plan, runs, source):
    with source.open("rb") as stream:
        mesh = trimesh.load_mesh(stream, file_type="obj", skip_materials=True,
                                 process=False, maintain_order=True)
    vertical = np.abs(mesh.face_normals[:, 1]) < .5
    scan = mesh.triangles[vertical]
    normals = mesh.face_normals[vertical][:, [0, 2]]
    xz = scan[:, :, [0, 2]]
    bounds_min, bounds_max = xz.min(axis=1), xz.max(axis=1)
    areas = dict.fromkeys(WALL_LAYERS, 0.)
    for ring_name, ring in [("Outer", plan.exterior), ("Courtyard", plan.interiors[0])]:
        points = np.array(ring.coords)
        heights = section_heights(points, runs)
        for i, (start, end) in enumerate(zip(points, points[1:])):
            delta = end - start
            length = np.linalg.norm(delta)
            tangent = delta / length
            inward = np.array([-tangent[1], tangent[0]])
            floor_a, floor_b = heights[i:i + 2, 0]
            head_a, head_b = heights[i:i + 2, 1] - heights[i:i + 2, 0]
            panel = shapely.Polygon([(0, 0), (length, 0), (length, head_b), (0, head_a)])

            # Rectify nearby, similarly oriented survey triangles onto the panel.
            # Its exact polygon difference supplies the missing area, so adjacent
            # measured and inferred pieces share edges and never stack faces.
            tolerance = .20
            near = ((bounds_min <= np.maximum(start, end) + tolerance).all(axis=1)
                    & (bounds_max >= np.minimum(start, end) - tolerance).all(axis=1)
                    & (normals @ inward > .85))
            offsets = xz[near] - start
            on_wall = np.abs(offsets @ inward).max(axis=1) <= tolerance
            along = offsets[on_wall] @ tangent
            elevation = scan[near][on_wall, :, 1] - (floor_a + along / length * (floor_b - floor_a))
            footprints = shapely.polygons(np.stack((along, elevation), axis=-1))
            observed = shapely.union_all(footprints, grid_size=.01).simplify(.025)
            observed = panel.intersection(observed)
            for layer, patch in [("Walls", observed), ("Estimated walls", panel.difference(observed))]:
                uv = triangles_2d(patch)
                if not len(uv):
                    continue
                xyz = np.empty((*uv.shape[:2], 3))
                xyz[:, :, [0, 2]] = start + uv[:, :, :1] * tangent
                xyz[:, :, 1] = uv[:, :, 1]
                add_surface(scene, layer, f"{ring_name} {i + 1:03} - {layer}", xyz,
                            [inward[0], 0, inward[1]])
                areas[layer] += patch.area
    return areas


def cutaway(scene, path):
    # Orthographic view from outside; the complete ceiling is present in the GLB.
    toward_eye = np.array([.78, 2.05, 1.0])
    toward_eye /= np.linalg.norm(toward_eye)
    right = np.cross([0, 1, 0], toward_eye)
    right /= np.linalg.norm(right)
    up = np.cross(toward_eye, right)
    basis = np.column_stack((right, -up, toward_eye))
    projected, colors = [], []
    for mesh in scene.geometry.values():
        layer = mesh.visual.material.name
        if layer == "Ceiling":
            continue
        visible = np.ones(len(mesh.faces), dtype=bool) if layer in WALL_LAYERS else mesh.face_normals @ toward_eye > 0
        tris = mesh.triangles[visible]
        projected.extend(tris @ basis)
        light = .83 + .17 * np.abs(mesh.face_normals[visible, 0])
        if layer == "Floor":
            light[:] = 1
        colors.extend((np.array(COLORS[layer]) * light[:, None]).astype(int))
    projected = np.array(projected)
    xy = projected[:, :, :2]
    width = 1650
    scale = (width - 100) / np.ptp(xy[:, :, 0])
    pixels = ((xy - xy.min(axis=(0, 1))) * scale + 50) * 2
    height = int(np.ceil(pixels[:, :, 1].max() / 2)) + 50
    canvas = np.full((height * 2, width * 2, 3), (249, 249, 246), dtype=np.uint8)
    depth = np.full(canvas.shape[:2], -np.inf, dtype=np.float32)
    # Long floor triangles can pass behind several walls. Test depth per pixel.
    for corners, z, color in zip(pixels, projected[:, :, 2], colors):
        x0, y0 = np.floor(corners.min(axis=0)).astype(int)
        x1, y1 = np.ceil(corners.max(axis=0)).astype(int)
        y, x = np.ogrid[y0:y1 + 1, x0:x1 + 1]
        a, b, c = corners
        ab, ac = b - a, c - a
        det = ab[0] * ac[1] - ab[1] * ac[0]
        if abs(det) < 1e-8:
            continue
        u = ((x - a[0]) * ac[1] - (y - a[1]) * ac[0]) / det
        v = (ab[0] * (y - a[1]) - ab[1] * (x - a[0])) / det
        distance = z[0] + u * (z[1] - z[0]) + v * (z[2] - z[0])
        region = np.s_[y0:y1 + 1, x0:x1 + 1]
        show = (u >= 0) & (v >= 0) & (u + v <= 1) & (distance > depth[region])
        depth[region][show] = distance[show]
        canvas[region][show] = color
    Image.fromarray(canvas).resize((width, height), Image.Resampling.LANCZOS).save(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=OUTPUT, help="output directory")
    args = parser.parse_args()
    scene = trimesh.Scene(base_frame="Corridor")
    for layer in COLORS:
        scene.graph.update(frame_to=layer, frame_from="Corridor")
    runs = joined_runs()
    plan = floor_plan(runs)
    passage_surfaces(scene, plan, runs)
    areas = complete_walls(scene, plan, runs, SCAN)
    args.output.mkdir(parents=True, exist_ok=True)
    scene.export(args.output / "corridor.glb")
    cutaway(scene, args.output / "corridor-cutaway.png")
    print(f"Wall area: {areas['Walls']:.1f} m² observed, {areas['Estimated walls']:.1f} m² filled")


if __name__ == "__main__":
    main()
