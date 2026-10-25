"""Ordnance Survey National Grid references -> WGS84 latitude and longitude.

County recorders publish sightings against grid references, which is the right
way to record a British bird but not something a web map can plot. Converting
properly needs two steps that are easy to skip and wrong to skip:

1. The grid is a transverse Mercator projection on the *Airy 1830* ellipsoid,
   not on WGS84. Inverting the projection gives OSGB36 coordinates.
2. OSGB36 and WGS84 are different datums, around 100 m apart in Britain, so a
   Helmert transformation is needed as well. Omitting it puts every record
   about a hundred metres out - which matters at the scale a six-figure
   reference is claiming.

A four-figure reference (TR0064) locates a 1 km square and a six-figure one
(TR037675) a 100 m square; both are returned as the centre of their square,
with the square's size so the map can be honest about the precision.
"""
import math

# The National Grid's 500 km and 100 km lettering.
_FIRST = "ABCDEFGHJKLMNOPQRSTUVWXYZ"      # 'I' is not used

# Airy 1830, and the National Grid's projection parameters.
_A = 6377563.396
_B = 6356256.909
_F0 = 0.9996012717
_LAT0 = math.radians(49.0)
_LON0 = math.radians(-2.0)
_N0 = -100000.0
_E0 = 400000.0

# OSGB36 -> WGS84 Helmert parameters (metres, arc-seconds, ppm).
_TX, _TY, _TZ = 446.448, -125.157, 542.060
_RX, _RY, _RZ = 0.1502, 0.2470, 0.8421
_S = -20.4894e-6


def parse_gridref(ref):
    """'TR037675' -> (easting, northing, square_size_m), or None."""
    if not ref:
        return None
    ref = "".join(str(ref).split()).upper()
    if len(ref) < 3 or not ref[:2].isalpha() or not ref[2:].isdigit():
        return None
    digits = ref[2:]
    if len(digits) % 2:
        return None

    i1, i2 = _FIRST.find(ref[0]), _FIRST.find(ref[1])
    if i1 < 0 or i2 < 0:
        return None
    # 500 km square, then the 100 km square within it. The northing origin
    # sits 19 hundred-kilometre squares up from the lettering's own origin.
    e = ((i1 - 2) % 5) * 500000 + (i2 % 5) * 100000
    n = (19 - (i1 // 5) * 5 - (i2 // 5)) * 100000

    half = len(digits) // 2
    if half == 0 or half > 5:
        return None
    scale = 10 ** (5 - half)
    e += int(digits[:half]) * scale
    n += int(digits[half:]) * scale
    # Outside the grid proper - a letter pair like XX is syntactically fine
    # but describes nowhere in Britain.
    if not (0 <= e < 800000 and 0 <= n < 1400000):
        return None
    # Report the centre of the square the reference actually describes.
    return e + scale / 2, n + scale / 2, scale


def _osgb36_to_wgs84(lat, lon):
    """Helmert transformation, Airy 1830 -> WGS84."""
    a, b = _A, _B
    e2 = 1 - (b * b) / (a * a)
    nu = a / math.sqrt(1 - e2 * math.sin(lat) ** 2)

    x1 = nu * math.cos(lat) * math.cos(lon)
    y1 = nu * math.cos(lat) * math.sin(lon)
    z1 = (1 - e2) * nu * math.sin(lat)

    rx = math.radians(_RX / 3600)
    ry = math.radians(_RY / 3600)
    rz = math.radians(_RZ / 3600)

    x2 = _TX + x1 * (1 + _S) - y1 * rz + z1 * ry
    y2 = _TY + x1 * rz + y1 * (1 + _S) - z1 * rx
    z2 = _TZ - x1 * ry + y1 * rx + z1 * (1 + _S)

    # WGS84 ellipsoid.
    a2, b2 = 6378137.000, 6356752.3142
    e2b = 1 - (b2 * b2) / (a2 * a2)
    p = math.hypot(x2, y2)
    lat2 = math.atan2(z2, p * (1 - e2b))
    for _ in range(8):
        nu2 = a2 / math.sqrt(1 - e2b * math.sin(lat2) ** 2)
        lat2 = math.atan2(z2 + e2b * nu2 * math.sin(lat2), p)
    return math.degrees(lat2), math.degrees(math.atan2(y2, x2))


def gridref_to_latlon(ref):
    """'TR037675' -> (lat, lon, square_size_m) in WGS84, or None."""
    parsed = parse_gridref(ref)
    if not parsed:
        return None
    east, north, size = parsed

    # Invert the transverse Mercator projection (OS guide, section C).
    a, b, f0 = _A, _B, _F0
    n = (a - b) / (a + b)
    e2 = 1 - (b * b) / (a * a)

    lat = _LAT0
    m = 0.0
    for _ in range(100):
        lat = (north - _N0 - m) / (a * f0) + lat
        dlat, slat = lat - _LAT0, lat + _LAT0
        ma = (1 + n + 1.25 * n * n + 1.25 * n ** 3) * dlat
        mb = (3 * n + 3 * n * n + 2.625 * n ** 3) * math.sin(dlat) * math.cos(slat)
        mc = (1.875 * n * n + 1.875 * n ** 3) * math.sin(2 * dlat) * math.cos(2 * slat)
        md = (35 / 24) * n ** 3 * math.sin(3 * dlat) * math.cos(3 * slat)
        m = b * f0 * (ma - mb + mc - md)
        if abs(north - _N0 - m) < 1e-5:
            break

    sl, cl, tl = math.sin(lat), math.cos(lat), math.tan(lat)
    nu = a * f0 / math.sqrt(1 - e2 * sl * sl)
    rho = a * f0 * (1 - e2) / (1 - e2 * sl * sl) ** 1.5
    eta2 = nu / rho - 1

    t2, t4, t6 = tl ** 2, tl ** 4, tl ** 6
    vii = tl / (2 * rho * nu)
    viii = tl / (24 * rho * nu ** 3) * (5 + 3 * t2 + eta2 - 9 * t2 * eta2)
    ix = tl / (720 * rho * nu ** 5) * (61 + 90 * t2 + 45 * t4)
    x = 1 / (cl * nu)
    xi = 1 / (cl * 6 * nu ** 3) * (nu / rho + 2 * t2)
    xii = 1 / (cl * 120 * nu ** 5) * (5 + 28 * t2 + 24 * t4)
    xiia = 1 / (cl * 5040 * nu ** 7) * (61 + 662 * t2 + 1320 * t4 + 720 * t6)

    de = east - _E0
    lat_osgb = lat - vii * de ** 2 + viii * de ** 4 - ix * de ** 6
    lon_osgb = _LON0 + x * de - xi * de ** 3 + xii * de ** 5 - xiia * de ** 7

    wlat, wlon = _osgb36_to_wgs84(lat_osgb, lon_osgb)
    return round(wlat, 6), round(wlon, 6), size
