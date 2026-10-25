"""UK bird species list, name normalisation and vernacular lookup.

Sources disagree on vernacular names ("Eurasian Blackbird" on eBird/iNat vs
"Blackbird" in a county blog), so the scientific binomial is used as the join
key and every known vernacular form is registered as an alias.
"""
import json
import re
import unicodedata

from .config import CFG
from .db import db
from .util import RateLimiter, log, request_json

EBIRD_TAXONOMY = "https://api.ebird.org/v2/ref/taxonomy/ebird"
EBIRD_GB_SPPLIST = "https://api.ebird.org/v2/product/spplist/GB"
INAT_SPECIES_COUNTS = "https://api.inaturalist.org/v1/observations/species_counts"
INAT_UK_PLACE_ID = 6857

_limiter = RateLimiter(0.6)

# Words that sources bolt onto British vernacular names. Stripping them gives
# the shorter form birders actually write. "Great" and "Little" are never
# stripped - they distinguish real species (Great Tit, Little Egret).
_PREFIX_NOISE = ("common", "eurasian", "european", "northern", "western",
                 "greater", "atlantic")

# Shorthand used in county bird reports and blogs.
MANUAL_ALIASES = {
    "gbb gull": "Larus marinus",
    "gbbg": "Larus marinus",
    "great black backed gull": "Larus marinus",
    "lbb gull": "Larus fuscus",
    "lbbg": "Larus fuscus",
    "lesser black backed gull": "Larus fuscus",
    "bh gull": "Chroicocephalus ridibundus",
    "bhg": "Chroicocephalus ridibundus",
    "med gull": "Ichthyaetus melanocephalus",
    "rnp": "Psittacula krameri",
    "ring necked parakeet": "Psittacula krameri",
    "gc grebe": "Podiceps cristatus",
    "gcg": "Podiceps cristatus",
    "lrp": "Charadrius dubius",
    "little ringed plover": "Charadrius dubius",
    "grp": "Charadrius hiaticula",
    "gsw": "Dendrocopos major",
    "great spotted woodpecker": "Dendrocopos major",
    "lsw": "Dryobates minor",
    "lesser spotted woodpecker": "Dryobates minor",
    "gwe": "Ardea alba",
    "cetti s warbler": "Cettia cetti",
    "cettis warbler": "Cettia cetti",
    "ltt": "Aegithalos caudatus",
    "long tailed tit": "Aegithalos caudatus",
    "house martin": "Delichon urbicum",
    "sand martin": "Riparia riparia",
    "pied wagtail": "Motacilla alba",
    "grey wagtail": "Motacilla cinerea",
    "yellow wagtail": "Motacilla flava",
    "water rail": "Rallus aquaticus",
    "barn owl": "Tyto alba",
    "tawny owl": "Strix aluco",
    "little owl": "Athene noctua",
    "short eared owl": "Asio flammeus",
    "seo": "Asio flammeus",
    "long eared owl": "Asio otus",
    "crow": "Corvus corone",
    "carrion crow": "Corvus corone",
    "feral pigeon": "Columba livia",
    "wood pigeon": "Columba palumbus",
    "woodpigeon": "Columba palumbus",
    "collared dove": "Streptopelia decaocto",
    "mipit": "Anthus pratensis",
    "meadow pipit": "Anthus pratensis",
    "rock pipit": "Anthus petrosus",
    "water pipit": "Anthus spinoletta",
    "tree pipit": "Anthus trivialis",
    "stock dove": "Columba oenas",
    "mistle thrush": "Turdus viscivorus",
    "song thrush": "Turdus philomelos",
    "blackbird": "Turdus merula",
    "robin": "Erithacus rubecula",
    "dunnock": "Prunella modularis",
    "wren": "Troglodytes troglodytes",
    "goldcrest": "Regulus regulus",
    "firecrest": "Regulus ignicapilla",
    "chiffchaff": "Phylloscopus collybita",
    "willow warbler": "Phylloscopus trochilus",
    "blackcap": "Sylvia atricapilla",
    "whitethroat": "Curruca communis",
    "lesser whitethroat": "Curruca curruca",
    "stonechat": "Saxicola rubicola",
    "whinchat": "Saxicola rubetra",
    "wheatear": "Oenanthe oenanthe",
    "redstart": "Phoenicurus phoenicurus",
    "black redstart": "Phoenicurus ochruros",
    "spotted flycatcher": "Muscicapa striata",
    "pied flycatcher": "Ficedula hypoleuca",
    "treecreeper": "Certhia familiaris",
    "nuthatch": "Sitta europaea",
    "jay": "Garrulus glandarius",
    "magpie": "Pica pica",
    "jackdaw": "Corvus monedula",
    "rook": "Corvus frugilegus",
    "raven": "Corvus corax",
    "starling": "Sturnus vulgaris",
    "house sparrow": "Passer domesticus",
    "tree sparrow": "Passer montanus",
    "chaffinch": "Fringilla coelebs",
    "brambling": "Fringilla montifringilla",
    "greenfinch": "Chloris chloris",
    "goldfinch": "Carduelis carduelis",
    "siskin": "Spinus spinus",
    "linnet": "Linaria cannabina",
    "twite": "Linaria flavirostris",
    "lesser redpoll": "Acanthis cabaret",
    "redpoll": "Acanthis flammea",
    "crossbill": "Loxia curvirostra",
    "bullfinch": "Pyrrhula pyrrhula",
    "hawfinch": "Coccothraustes coccothraustes",
    "yellowhammer": "Emberiza citrinella",
    "reed bunting": "Emberiza schoeniclus",
    "corn bunting": "Emberiza calandra",
    "cirl bunting": "Emberiza cirlus",
    "skylark": "Alauda arvensis",
    "woodlark": "Lullula arborea",
    "blue tit": "Cyanistes caeruleus",
    "great tit": "Parus major",
    "coal tit": "Periparus ater",
    "marsh tit": "Poecile palustris",
    "willow tit": "Poecile montanus",
    "bearded tit": "Panurus biarmicus",
    "reed warbler": "Acrocephalus scirpaceus",
    "sedge warbler": "Acrocephalus schoenobaenus",
    "grasshopper warbler": "Locustella naevia",
    "garden warbler": "Sylvia borin",
    "redwing": "Turdus iliacus",
    "fieldfare": "Turdus pilaris",
    "ring ouzel": "Turdus torquatus",
    "lapwing": "Vanellus vanellus",
    "golden plover": "Pluvialis apricaria",
    "grey plover": "Pluvialis squatarola",
    "ringed plover": "Charadrius hiaticula",
    "dunlin": "Calidris alpina",
    "knot": "Calidris canutus",
    "sanderling": "Calidris alba",
    "turnstone": "Arenaria interpres",
    "redshank": "Tringa totanus",
    "spotted redshank": "Tringa erythropus",
    "greenshank": "Tringa nebularia",
    "curlew": "Numenius arquata",
    "whimbrel": "Numenius phaeopus",
    "black tailed godwit": "Limosa limosa",
    "bar tailed godwit": "Limosa lapponica",
    "snipe": "Gallinago gallinago",
    "jack snipe": "Lymnocryptes minimus",
    "woodcock": "Scolopax rusticola",
    "oystercatcher": "Haematopus ostralegus",
    "avocet": "Recurvirostra avosetta",
    "common sandpiper": "Actitis hypoleucos",
    "green sandpiper": "Tringa ochropus",
    "wood sandpiper": "Tringa glareola",
    "ruff": "Calidris pugnax",
    "little stint": "Calidris minuta",
    "curlew sandpiper": "Calidris ferruginea",
    "mute swan": "Cygnus olor",
    "whooper swan": "Cygnus cygnus",
    "bewick s swan": "Cygnus columbianus",
    "canada goose": "Branta canadensis",
    "greylag goose": "Anser anser",
    "pink footed goose": "Anser brachyrhynchus",
    "white fronted goose": "Anser albifrons",
    "brent goose": "Branta bernicla",
    "barnacle goose": "Branta leucopsis",
    "egyptian goose": "Alopochen aegyptiaca",
    "shelduck": "Tadorna tadorna",
    "mallard": "Anas platyrhynchos",
    "gadwall": "Mareca strepera",
    "wigeon": "Mareca penelope",
    "teal": "Anas crecca",
    "pintail": "Anas acuta",
    "shoveler": "Spatula clypeata",
    "shovelor": "Spatula clypeata",
    "garganey": "Spatula querquedula",
    "pochard": "Aythya ferina",
    "tufted duck": "Aythya fuligula",
    "scaup": "Aythya marila",
    "goldeneye": "Bucephala clangula",
    "goosander": "Mergus merganser",
    "red breasted merganser": "Mergus serrator",
    "smew": "Mergellus albellus",
    "eider": "Somateria mollissima",
    "common scoter": "Melanitta nigra",
    "mandarin": "Aix galericulata",
    "mandarin duck": "Aix galericulata",
    "little grebe": "Tachybaptus ruficollis",
    "great crested grebe": "Podiceps cristatus",
    "slavonian grebe": "Podiceps auritus",
    "black necked grebe": "Podiceps nigricollis",
    "cormorant": "Phalacrocorax carbo",
    "shag": "Gulosus aristotelis",
    "grey heron": "Ardea cinerea",
    "little egret": "Egretta garzetta",
    "great white egret": "Ardea alba",
    "cattle egret": "Bubulcus ibis",
    "bittern": "Botaurus stellaris",
    "spoonbill": "Platalea leucorodia",
    "glossy ibis": "Plegadis falcinellus",
    "gannet": "Morus bassanus",
    "fulmar": "Fulmarus glacialis",
    "manx shearwater": "Puffinus puffinus",
    "storm petrel": "Hydrobates pelagicus",
    "kittiwake": "Rissa tridactyla",
    "common gull": "Larus canus",
    "herring gull": "Larus argentatus",
    "yellow legged gull": "Larus michahellis",
    "caspian gull": "Larus cachinnans",
    "iceland gull": "Larus glaucoides",
    "glaucous gull": "Larus hyperboreus",
    "little gull": "Hydrocoloeus minutus",
    "black headed gull": "Chroicocephalus ridibundus",
    "mediterranean gull": "Ichthyaetus melanocephalus",
    "sandwich tern": "Thalasseus sandvicensis",
    "common tern": "Sterna hirundo",
    "arctic tern": "Sterna paradisaea",
    "little tern": "Sternula albifrons",
    "black tern": "Chlidonias niger",
    "guillemot": "Uria aalge",
    "razorbill": "Alca torda",
    "puffin": "Fratercula arctica",
    "red kite": "Milvus milvus",
    "buzzard": "Buteo buteo",
    "sparrowhawk": "Accipiter nisus",
    "goshawk": "Accipiter gentilis",
    "marsh harrier": "Circus aeruginosus",
    "hen harrier": "Circus cyaneus",
    "osprey": "Pandion haliaetus",
    "kestrel": "Falco tinnunculus",
    "merlin": "Falco columbarius",
    "hobby": "Falco subbuteo",
    "peregrine": "Falco peregrinus",
    "white tailed eagle": "Haliaeetus albicilla",
    "golden eagle": "Aquila chrysaetos",
    "kingfisher": "Alcedo atthis",
    "green woodpecker": "Picus viridis",
    "cuckoo": "Cuculus canorus",
    "swift": "Apus apus",
    "swallow": "Hirundo rustica",
    "nightjar": "Caprimulgus europaeus",
    "pheasant": "Phasianus colchicus",
    "red legged partridge": "Alectoris rufa",
    "grey partridge": "Perdix perdix",
    "red grouse": "Lagopus lagopus",
    "black grouse": "Lyrurus tetrix",
    "quail": "Coturnix coturnix",
    "moorhen": "Gallinula chloropus",
    "coot": "Fulica atra",
    "crane": "Grus grus",
    "dipper": "Cinclus cinclus",
    "nightingale": "Luscinia megarhynchos",
    "wryneck": "Jynx torquilla",
    "waxwing": "Bombycilla garrulus",
    "great northern diver": "Gavia immer",
    "red throated diver": "Gavia stellata",
    "black throated diver": "Gavia arctica",
    "chough": "Pyrrhocorax pyrrhocorax",
    "snow bunting": "Plectrophenax nivalis",
    "lapland bunting": "Calcarius lapponicus",
    "yellow browed warbler": "Phylloscopus inornatus",
    "pallas s warbler": "Phylloscopus proregulus",
    "great grey shrike": "Lanius excubitor",
    "red backed shrike": "Lanius collurio",
    "hoopoe": "Upupa epops",
    "bee eater": "Merops apiaster",
    "turtle dove": "Streptopelia turtur",
    "corncrake": "Crex crex",
    "spotted crake": "Porzana porzana",
    "grey phalarope": "Phalaropus fulicarius",
    "red necked phalarope": "Phalaropus lobatus",
    "arctic skua": "Stercorarius parasiticus",
    "great skua": "Stercorarius skua",
    "pomarine skua": "Stercorarius pomarinus",
}

# eBird and iNaturalist use global English book names ("Eurasian Blackbird",
# "Northern Shoveler"). UK birders and county reports use the British forms, so
# these take priority for display. Scientific name -> British name.
_BRITISH_NAMES_RAW = """
Turdus merula=Blackbird
Erithacus rubecula=Robin
Columba palumbus=Woodpigeon
Columba livia=Feral Pigeon
Columba oenas=Stock Dove
Streptopelia decaocto=Collared Dove
Streptopelia turtur=Turtle Dove
Troglodytes troglodytes=Wren
Prunella modularis=Dunnock
Sturnus vulgaris=Starling
Passer domesticus=House Sparrow
Passer montanus=Tree Sparrow
Fringilla coelebs=Chaffinch
Chloris chloris=Greenfinch
Carduelis carduelis=Goldfinch
Spinus spinus=Siskin
Linaria cannabina=Linnet
Linaria flavirostris=Twite
Acanthis flammea=Common Redpoll
Acanthis cabaret=Lesser Redpoll
Loxia curvirostra=Common Crossbill
Pyrrhula pyrrhula=Bullfinch
Coccothraustes coccothraustes=Hawfinch
Emberiza citrinella=Yellowhammer
Emberiza schoeniclus=Reed Bunting
Emberiza calandra=Corn Bunting
Emberiza cirlus=Cirl Bunting
Plectrophenax nivalis=Snow Bunting
Calcarius lapponicus=Lapland Bunting
Alauda arvensis=Skylark
Lullula arborea=Woodlark
Cyanistes caeruleus=Blue Tit
Parus major=Great Tit
Periparus ater=Coal Tit
Poecile palustris=Marsh Tit
Poecile montanus=Willow Tit
Aegithalos caudatus=Long-tailed Tit
Panurus biarmicus=Bearded Tit
Sitta europaea=Nuthatch
Certhia familiaris=Treecreeper
Regulus regulus=Goldcrest
Regulus ignicapilla=Firecrest
Phylloscopus collybita=Chiffchaff
Phylloscopus trochilus=Willow Warbler
Phylloscopus inornatus=Yellow-browed Warbler
Phylloscopus sibilatrix=Wood Warbler
Sylvia atricapilla=Blackcap
Sylvia borin=Garden Warbler
Curruca communis=Whitethroat
Curruca curruca=Lesser Whitethroat
Cettia cetti=Cetti's Warbler
Acrocephalus scirpaceus=Reed Warbler
Acrocephalus schoenobaenus=Sedge Warbler
Locustella naevia=Grasshopper Warbler
Saxicola rubicola=Stonechat
Saxicola rubetra=Whinchat
Oenanthe oenanthe=Wheatear
Phoenicurus phoenicurus=Redstart
Phoenicurus ochruros=Black Redstart
Muscicapa striata=Spotted Flycatcher
Ficedula hypoleuca=Pied Flycatcher
Luscinia megarhynchos=Nightingale
Turdus philomelos=Song Thrush
Turdus viscivorus=Mistle Thrush
Turdus iliacus=Redwing
Turdus pilaris=Fieldfare
Turdus torquatus=Ring Ouzel
Cinclus cinclus=Dipper
Bombycilla garrulus=Waxwing
Motacilla alba=Pied Wagtail
Motacilla cinerea=Grey Wagtail
Motacilla flava=Yellow Wagtail
Anthus pratensis=Meadow Pipit
Anthus trivialis=Tree Pipit
Anthus petrosus=Rock Pipit
Anthus spinoletta=Water Pipit
Garrulus glandarius=Jay
Pica pica=Magpie
Corvus monedula=Jackdaw
Corvus frugilegus=Rook
Corvus corone=Carrion Crow
Corvus cornix=Hooded Crow
Corvus corax=Raven
Pyrrhocorax pyrrhocorax=Chough
Lanius excubitor=Great Grey Shrike
Lanius collurio=Red-backed Shrike
Hirundo rustica=Swallow
Delichon urbicum=House Martin
Riparia riparia=Sand Martin
Apus apus=Swift
Caprimulgus europaeus=Nightjar
Alcedo atthis=Kingfisher
Upupa epops=Hoopoe
Merops apiaster=Bee-eater
Jynx torquilla=Wryneck
Picus viridis=Green Woodpecker
Dendrocopos major=Great Spotted Woodpecker
Dryobates minor=Lesser Spotted Woodpecker
Cuculus canorus=Cuckoo
Psittacula krameri=Ring-necked Parakeet
Tyto alba=Barn Owl
Strix aluco=Tawny Owl
Athene noctua=Little Owl
Asio otus=Long-eared Owl
Asio flammeus=Short-eared Owl
Falco tinnunculus=Kestrel
Falco columbarius=Merlin
Falco subbuteo=Hobby
Falco peregrinus=Peregrine
Accipiter nisus=Sparrowhawk
Accipiter gentilis=Goshawk
Buteo buteo=Buzzard
Buteo lagopus=Rough-legged Buzzard
Pernis apivorus=Honey Buzzard
Milvus milvus=Red Kite
Circus aeruginosus=Marsh Harrier
Circus cyaneus=Hen Harrier
Circus pygargus=Montagu's Harrier
Haliaeetus albicilla=White-tailed Eagle
Aquila chrysaetos=Golden Eagle
Pandion haliaetus=Osprey
Phalacrocorax carbo=Cormorant
Gulosus aristotelis=Shag
Morus bassanus=Gannet
Ardea cinerea=Grey Heron
Ardea alba=Great White Egret
Egretta garzetta=Little Egret
Bubulcus ibis=Cattle Egret
Botaurus stellaris=Bittern
Nycticorax nycticorax=Night Heron
Platalea leucorodia=Spoonbill
Plegadis falcinellus=Glossy Ibis
Ciconia ciconia=White Stork
Grus grus=Crane
Rallus aquaticus=Water Rail
Gallinula chloropus=Moorhen
Fulica atra=Coot
Crex crex=Corncrake
Porzana porzana=Spotted Crake
Cygnus olor=Mute Swan
Cygnus cygnus=Whooper Swan
Cygnus columbianus=Bewick's Swan
Anser anser=Greylag Goose
Anser brachyrhynchus=Pink-footed Goose
Anser albifrons=White-fronted Goose
Anser fabalis=Bean Goose
Branta canadensis=Canada Goose
Branta bernicla=Brent Goose
Branta leucopsis=Barnacle Goose
Alopochen aegyptiaca=Egyptian Goose
Tadorna tadorna=Shelduck
Aix galericulata=Mandarin Duck
Anas platyrhynchos=Mallard
Anas crecca=Teal
Anas acuta=Pintail
Mareca strepera=Gadwall
Mareca penelope=Wigeon
Spatula clypeata=Shoveler
Spatula querquedula=Garganey
Aythya ferina=Pochard
Aythya fuligula=Tufted Duck
Aythya marila=Scaup
Aythya nyroca=Ferruginous Duck
Bucephala clangula=Goldeneye
Mergus merganser=Goosander
Mergus serrator=Red-breasted Merganser
Mergellus albellus=Smew
Somateria mollissima=Eider
Melanitta nigra=Common Scoter
Melanitta fusca=Velvet Scoter
Clangula hyemalis=Long-tailed Duck
Tachybaptus ruficollis=Little Grebe
Podiceps cristatus=Great Crested Grebe
Podiceps auritus=Slavonian Grebe
Podiceps nigricollis=Black-necked Grebe
Podiceps grisegena=Red-necked Grebe
Gavia stellata=Red-throated Diver
Gavia arctica=Black-throated Diver
Gavia immer=Great Northern Diver
Fulmarus glacialis=Fulmar
Puffinus puffinus=Manx Shearwater
Hydrobates pelagicus=Storm Petrel
Haematopus ostralegus=Oystercatcher
Recurvirostra avosetta=Avocet
Vanellus vanellus=Lapwing
Pluvialis apricaria=Golden Plover
Pluvialis squatarola=Grey Plover
Charadrius hiaticula=Ringed Plover
Charadrius dubius=Little Ringed Plover
Charadrius morinellus=Dotterel
Numenius arquata=Curlew
Numenius phaeopus=Whimbrel
Limosa limosa=Black-tailed Godwit
Limosa lapponica=Bar-tailed Godwit
Tringa totanus=Redshank
Tringa erythropus=Spotted Redshank
Tringa nebularia=Greenshank
Tringa ochropus=Green Sandpiper
Tringa glareola=Wood Sandpiper
Actitis hypoleucos=Common Sandpiper
Arenaria interpres=Turnstone
Calidris alpina=Dunlin
Calidris canutus=Knot
Calidris alba=Sanderling
Calidris minuta=Little Stint
Calidris temminckii=Temminck's Stint
Calidris ferruginea=Curlew Sandpiper
Calidris maritima=Purple Sandpiper
Calidris pugnax=Ruff
Gallinago gallinago=Snipe
Lymnocryptes minimus=Jack Snipe
Scolopax rusticola=Woodcock
Phalaropus lobatus=Red-necked Phalarope
Phalaropus fulicarius=Grey Phalarope
Stercorarius skua=Great Skua
Stercorarius parasiticus=Arctic Skua
Stercorarius pomarinus=Pomarine Skua
Stercorarius longicaudus=Long-tailed Skua
Rissa tridactyla=Kittiwake
Larus canus=Common Gull
Larus argentatus=Herring Gull
Larus michahellis=Yellow-legged Gull
Larus cachinnans=Caspian Gull
Larus fuscus=Lesser Black-backed Gull
Larus marinus=Great Black-backed Gull
Larus glaucoides=Iceland Gull
Larus hyperboreus=Glaucous Gull
Chroicocephalus ridibundus=Black-headed Gull
Hydrocoloeus minutus=Little Gull
Ichthyaetus melanocephalus=Mediterranean Gull
Thalasseus sandvicensis=Sandwich Tern
Sterna hirundo=Common Tern
Sterna paradisaea=Arctic Tern
Sternula albifrons=Little Tern
Chlidonias niger=Black Tern
Uria aalge=Guillemot
Alca torda=Razorbill
Fratercula arctica=Puffin
Cepphus grylle=Black Guillemot
Alle alle=Little Auk
Phasianus colchicus=Pheasant
Alectoris rufa=Red-legged Partridge
Perdix perdix=Grey Partridge
Coturnix coturnix=Quail
Lagopus lagopus=Red Grouse
Lagopus muta=Ptarmigan
Lyrurus tetrix=Black Grouse
Tetrao urogallus=Capercaillie
"""

BRITISH_NAMES = {}
for _line in _BRITISH_NAMES_RAW.strip().splitlines():
    _sci, _, _brit = _line.partition("=")
    if _sci and _brit:
        BRITISH_NAMES[_sci.strip()] = _brit.strip()

# Not birds: BirdNET reports these alongside species and they must not be mapped.
NON_BIRD_LABELS = {
    "engine", "siren", "fireworks", "gun", "human vocal", "human non-vocal",
    "human whistle", "dog", "power tools", "environmental", "noise",
    "human", "cat", "coyote", "red squirrel", "eastern gray squirrel",
    "gray squirrel", "squirrel", "spring peeper", "american red squirrel",
    "common frog", "church bell", "honey bee", "field cricket",
}


def strip_accents(s):
    return "".join(c for c in unicodedata.normalize("NFKD", s)
                   if not unicodedata.combining(c))


def norm(name):
    """Normalise a name for matching: lowercase, no accents or punctuation."""
    if not name:
        return ""
    s = strip_accents(str(name)).lower()
    s = re.sub(r"[‘’'`]", " ", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


# Genus splits where sources disagree. Mapped onto the form eBird uses, since
# eBird supplies most records; both forms then resolve to one species.
SCI_SYNONYMS = {
    "corvus monedula": "coloeus monedula",
    "accipiter gentilis": "astur gentilis",
    "bubulcus ibis": "ardea ibis",
    "charadrius dubius": "thinornis dubius",
    "charadrius morinellus": "eudromias morinellus",
    "lagopus lagopus": "lagopus scotica",
    "phalacrocorax aristotelis": "gulosus aristotelis",
    "sylvia communis": "curruca communis",
    "sylvia curruca": "curruca curruca",
    "carduelis cabaret": "acanthis cabaret",
    "carduelis flammea": "acanthis flammea",
    "carduelis chloris": "chloris chloris",
    "carduelis cannabina": "linaria cannabina",
    "carduelis flavirostris": "linaria flavirostris",
    "carduelis spinus": "spinus spinus",
    "parus caeruleus": "cyanistes caeruleus",
    "parus ater": "periparus ater",
    "parus palustris": "poecile palustris",
    "parus montanus": "poecile montanus",
    "parus cristatus": "lophophanes cristatus",
    "anas strepera": "mareca strepera",
    "anas penelope": "mareca penelope",
    "anas clypeata": "spatula clypeata",
    "anas querquedula": "spatula querquedula",
    "larus ridibundus": "chroicocephalus ridibundus",
    "larus melanocephalus": "ichthyaetus melanocephalus",
    "larus minutus": "hydrocoloeus minutus",
    "sterna sandvicensis": "thalasseus sandvicensis",
    "sterna albifrons": "sternula albifrons",
    "sula bassana": "morus bassanus",
    "miliaria calandra": "emberiza calandra",
    "saxicola torquatus": "saxicola rubicola",
    "delichon urbica": "delichon urbicum",
    "dendrocopos minor": "dryobates minor",
    "philomachus pugnax": "calidris pugnax",
    "calidris alpina alpina": "calidris alpina",
    "tetrao tetrix": "lyrurus tetrix",
    "lagopus mutus": "lagopus muta",
    "oceanodroma leucorhoa": "hydrobates leucorhous",
    "hydrobates leucorhoa": "hydrobates leucorhous",
}


def sci_key(sci):
    """Species key: the normalised binomial, so subspecies collapse to species."""
    n = norm(sci)
    if not n:
        return ""
    if n in SCI_SYNONYMS:
        return SCI_SYNONYMS[n]
    parts = n.split()
    key = " ".join(parts[:2]) if len(parts) >= 2 else parts[0]
    return SCI_SYNONYMS.get(key, key)


def short_variants(common):
    """Shorter British forms of a long book name, e.g. Eurasian Blackbird."""
    out = set()
    n = norm(common)
    out.add(n)
    out.add(n.replace(" ", ""))
    words = n.split()
    for noise in _PREFIX_NOISE:
        if len(words) > 1 and words[0] == noise:
            out.add(" ".join(words[1:]))
    return {v for v in out if v}


class SpeciesIndex:
    """Vernacular / scientific name -> canonical species record."""

    def __init__(self, records):
        # records: list of dicts with species_key, common, sci, uk_records
        self.by_key = {r["species_key"]: r for r in records}
        self.alias = {}
        for r in records:
            for a in set(r.get("aliases") or []):
                self.alias.setdefault(a, r["species_key"])
            self.alias.setdefault(sci_key(r["sci"]), r["species_key"])

    def lookup(self, name):
        """Return the canonical record for a vernacular or scientific name."""
        if not name:
            return None
        n = norm(name)
        if n in NON_BIRD_LABELS:
            return None
        key = self.alias.get(n)
        if key is None:
            # try as a binomial, then as a de-noised vernacular
            key = self.alias.get(sci_key(name))
        if key is None:
            words = n.split()
            for noise in _PREFIX_NOISE:
                if len(words) > 1 and words[0] == noise:
                    key = self.alias.get(" ".join(words[1:]))
                    break
        if key is None:
            return None
        return self.by_key.get(key)

    def canonical(self, common=None, sci=None):
        """Best (common, sci, species_key) for a record from any source."""
        rec = self.lookup(sci) if sci else None
        if rec is None and common:
            rec = self.lookup(common)
        if rec:
            return rec["common"], rec["sci"], rec["species_key"]
        if sci and len(norm(sci).split()) >= 2:
            return common or sci, sci, sci_key(sci)
        if common and norm(common) not in NON_BIRD_LABELS:
            return common, sci, "common:" + norm(common)
        return None, None, None

    @property
    def names(self):
        return sorted(r["common"] for r in self.by_key.values() if r["common"])


def _fetch_ebird_gb_taxonomy(token):
    """GB species list with British English vernacular names."""
    if not token:
        return []
    hdr = {"X-eBirdApiToken": token}
    codes = request_json("GET", EBIRD_GB_SPPLIST, headers=hdr,
                         limiter=_limiter, cache_hours=24 * 14)
    tax = request_json("GET", EBIRD_TAXONOMY, headers=hdr, limiter=_limiter,
                       cache_hours=24 * 14,
                       params={"fmt": "json", "locale": "en_UK", "cat": "species"})
    gb = set(codes or [])
    out = []
    for t in tax:
        if t.get("speciesCode") in gb and t.get("sciName"):
            out.append({"common": t.get("comName"), "sci": t["sciName"],
                        "origin": "ebird"})
    log.info("species: %d GB species from eBird taxonomy", len(out))
    return out


def _fetch_inat_uk_birds():
    """UK bird taxa seen on iNaturalist, with observation totals."""
    out = []
    for page in (1, 2, 3):
        d = request_json("GET", INAT_SPECIES_COUNTS, limiter=_limiter,
                         cache_hours=24 * 7,
                         params={"taxon_id": 3, "place_id": INAT_UK_PLACE_ID,
                                 "per_page": 500, "page": page,
                                 "rank": "species"})
        res = d.get("results", [])
        for r in res:
            t = r.get("taxon") or {}
            if t.get("name"):
                photo = t.get("default_photo") or {}
                out.append({"common": t.get("preferred_common_name") or t["name"],
                            "sci": t["name"], "uk_records": r.get("count", 0),
                            "photo": photo.get("square_url"),
                            "photo_credit": photo.get("attribution"),
                            "origin": "inat"})
        if len(res) < 500:
            break
    log.info("species: %d UK bird taxa from iNaturalist", len(out))
    return out


def build(force=False):
    """Build (or rebuild) the species table and return a SpeciesIndex."""
    with db() as conn:
        have = conn.execute("SELECT COUNT(*) c FROM species").fetchone()["c"]
        if have and not force:
            return load()

    merged = {}

    def add(rec, british=False):
        key = sci_key(rec["sci"])
        if not key:
            return
        m = merged.setdefault(key, {"species_key": key, "common": None,
                                    "sci": rec["sci"], "uk_records": 0,
                                    "aliases": set(), "photo": None,
                                    "photo_credit": None})
        if rec.get("common"):
            m["aliases"] |= short_variants(rec["common"])
            # eBird en_UK names are the British forms - prefer them for display
            if british or not m["common"]:
                m["common"] = rec["common"]
        m["uk_records"] = max(m["uk_records"], rec.get("uk_records", 0) or 0)
        if rec.get("photo") and not m.get("photo"):
            m["photo"] = rec["photo"]
            m["photo_credit"] = rec.get("photo_credit")
        m["aliases"].add(key)

    try:
        for r in _fetch_ebird_gb_taxonomy(CFG["ebird_api_token"]):
            add(r, british=True)
    except Exception as e:  # noqa: BLE001
        log.warning("species: eBird taxonomy unavailable (%s)", e)
    try:
        for r in _fetch_inat_uk_birds():
            add(r)
    except Exception as e:  # noqa: BLE001
        log.warning("species: iNaturalist taxa unavailable (%s)", e)

    # British vernacular names take priority for display, and both the British
    # and the global book name stay searchable as aliases.
    for bsci, bname in BRITISH_NAMES.items():
        key = sci_key(bsci)
        m = merged.get(key)
        if m is None:
            m = merged.setdefault(key, {"species_key": key, "common": None,
                                        "sci": bsci, "uk_records": 0,
                                        "aliases": {key}, "photo": None,
                                        "photo_credit": None})
        m["common"] = bname
        m["aliases"] |= short_variants(bname)

    # Manual shorthand, and any species only named in the manual table.
    sci_to_key = {sci_key(m["sci"]): k for k, m in merged.items()}
    for alias, sci in MANUAL_ALIASES.items():
        key = sci_to_key.get(sci_key(sci))
        if key is None:
            add({"common": alias.title(), "sci": sci}, british=False)
            key = sci_key(sci)
            sci_to_key[key] = key
        merged[key]["aliases"].add(norm(alias))

    rows = [(m["species_key"], m["common"], m["sci"], m["uk_records"],
             json.dumps(sorted(m["aliases"])), m.get("photo"),
             m.get("photo_credit")) for m in merged.values()]
    with db() as conn:
        conn.execute("DELETE FROM species")
        conn.executemany(
            "INSERT INTO species (species_key, common, sci, uk_records, aliases,"
            " photo, photo_credit) VALUES (?,?,?,?,?,?,?)", rows)
    log.info("species: %d species in index", len(rows))
    return load()


def load():
    with db() as conn:
        recs = []
        for r in conn.execute("SELECT * FROM species"):
            recs.append({"species_key": r["species_key"], "common": r["common"],
                         "sci": r["sci"], "uk_records": r["uk_records"],
                         "aliases": json.loads(r["aliases"] or "[]"),
                         "photo": r["photo"], "photo_credit": r["photo_credit"]})
    if not recs:
        return build()
    return SpeciesIndex(recs)
