// geo.js — GEOSLEUTH pure analysis module (no DOM).
// Country knowledge base + cue scoring engine + minimal EXIF parser + pixel heuristics.
// Runs in node (tests) and the browser (app.js) unchanged.

// ---------------------------------------------------------------------------
// Country knowledge base.
// Vocabularies (cue ids) — keep in sync with CUES below:
//   scripts: latin cyrillic arabic cjk devanagari thai hangul hebrew greek georgian
//   drive:   left right
//   plates:  eu uk us jp mercosur yellow arabic-num plain
//   marks:   yellow-center white-center
//   poles:   dense-wires wooden concrete uk-telegraph buried
//   arch:    old-town soviet mediterranean islamic east-asian us-suburb nordic-wood
//            colonial tropical-stilt skyscraper whitewashed adobe brutalist
//   veg:     palms desert temperate alpine jungle savanna scrub boreal paddy
//   terrain: mountains coast desert-land urban rural snow
//   street:  tuktuk taxi-yellow blackcab keicar pickup scooters bikes phonebox
//            doubledecker schoolbus tram
// ---------------------------------------------------------------------------
export const COUNTRIES = [
{id:'gb',name:'United Kingdom',region:'Europe',scripts:['latin'],drive:'left',plates:['uk'],marks:['white-center'],poles:['uk-telegraph'],arch:['old-town'],veg:['temperate'],terrain:[],street:['blackcab','phonebox','doubledecker'],tell:'Red post boxes, black cabs, white-front/yellow-rear plates.'},
{id:'ie',name:'Ireland',region:'Europe',scripts:['latin'],drive:'left',plates:['eu'],marks:['white-center'],poles:['wooden'],arch:['old-town'],veg:['temperate'],terrain:['coast','rural'],street:[],tell:'EU plates, lush green fields, Georgian Dublin terraces.'},
{id:'fr',name:'France',region:'Europe',scripts:['latin'],drive:'right',plates:['eu'],marks:['white-center'],poles:['concrete'],arch:['old-town','mediterranean'],veg:['temperate','scrub'],terrain:[],street:[],tell:'Haussmann blocks, blue-on-white town signs, priorité à droite.'},
{id:'de',name:'Germany',region:'Europe',scripts:['latin'],drive:'right',plates:['eu'],marks:['white-center'],poles:['buried'],arch:['old-town','brutalist'],veg:['temperate'],terrain:[],street:['tram'],tell:'Fachwerk old towns, yellow street signs, cables buried.'},
{id:'es',name:'Spain',region:'Europe',scripts:['latin'],drive:'right',plates:['eu'],marks:['white-center'],poles:['concrete'],arch:['mediterranean','old-town','islamic'],veg:['scrub','desert'],terrain:['coast','mountains'],street:[],tell:'Moorish south, tiled street names, arid meseta.'},
{id:'it',name:'Italy',region:'Europe',scripts:['latin'],drive:'right',plates:['eu'],marks:['white-center'],poles:['concrete'],arch:['mediterranean','old-town'],veg:['scrub'],terrain:['coast','mountains'],street:['scooters'],tell:'Renaissance cores, blue autostrada signs, Vespas.'},
{id:'pt',name:'Portugal',region:'Europe',scripts:['latin'],drive:'right',plates:['eu'],marks:['white-center'],poles:['concrete'],arch:['mediterranean','old-town','colonial'],veg:['scrub'],terrain:['coast'],street:['tram'],tell:'Azulejo tiles everywhere, black-white wave pavements.'},
{id:'nl',name:'Netherlands',region:'Europe',scripts:['latin'],drive:'right',plates:['yellow','eu'],marks:['white-center'],poles:['buried'],arch:['old-town'],veg:['temperate'],terrain:['rural'],street:['bikes'],tell:'Gabled canal houses, bikes everywhere, dead-flat polders.'},
{id:'be',name:'Belgium',region:'Europe',scripts:['latin'],drive:'right',plates:['eu'],marks:['white-center'],poles:['concrete'],arch:['old-town'],veg:['temperate'],terrain:[],street:['tram'],tell:'Bilingual FR/NL signs, Flemish step-gables.'},
{id:'ch',name:'Switzerland',region:'Europe',scripts:['latin'],drive:'right',plates:['plain'],marks:['white-center'],poles:['buried'],arch:['old-town'],veg:['alpine','temperate'],terrain:['mountains','snow'],street:['tram'],tell:'White plates with red shield, yellow hiking signs, Alps.'},
{id:'at',name:'Austria',region:'Europe',scripts:['latin'],drive:'right',plates:['eu'],marks:['white-center'],poles:['buried'],arch:['old-town'],veg:['alpine','temperate'],terrain:['mountains','snow'],street:['tram'],tell:'Baroque cores, Alpine valleys, EU plates.'},
{id:'se',name:'Sweden',region:'Europe',scripts:['latin'],drive:'right',plates:['eu'],marks:['white-center'],poles:['wooden'],arch:['nordic-wood'],veg:['boreal','temperate'],terrain:['coast','snow'],street:[],tell:'Red Falu cottages, endless pine, EU plates.'},
{id:'no',name:'Norway',region:'Europe',scripts:['latin'],drive:'right',plates:['plain'],marks:['white-center'],poles:['wooden'],arch:['nordic-wood'],veg:['boreal','alpine'],terrain:['mountains','coast','snow'],street:[],tell:'Fjords, stave churches, tunnels everywhere.'},
{id:'fi',name:'Finland',region:'Europe',scripts:['latin'],drive:'right',plates:['eu'],marks:['white-center'],poles:['wooden'],arch:['nordic-wood'],veg:['boreal'],terrain:['snow'],street:['tram'],tell:'Lakes, birch forest, bilingual FI/SV signs.'},
{id:'dk',name:'Denmark',region:'Europe',scripts:['latin'],drive:'right',plates:['eu'],marks:['white-center'],poles:['buried'],arch:['old-town','nordic-wood'],veg:['temperate'],terrain:['coast','rural'],street:['bikes'],tell:'Brick farmhouses, thatch, Copenhagen bikes.'},
{id:'pl',name:'Poland',region:'Europe',scripts:['latin'],drive:'right',plates:['eu'],marks:['white-center'],poles:['concrete'],arch:['soviet','old-town'],veg:['temperate'],terrain:['rural'],street:['tram'],tell:'Blokowiska estates, rebuilt old towns, EU plates.'},
{id:'cz',name:'Czechia',region:'Europe',scripts:['latin'],drive:'right',plates:['eu'],marks:['white-center'],poles:['concrete'],arch:['soviet','old-town'],veg:['temperate'],terrain:[],street:['tram'],tell:'Prague baroque, panelák estates, EU plates.'},
{id:'hu',name:'Hungary',region:'Europe',scripts:['latin'],drive:'right',plates:['eu'],marks:['white-center'],poles:['concrete'],arch:['soviet','old-town'],veg:['temperate'],terrain:['rural'],street:['tram'],tell:'Budapest eclectic blocks, puszta flatlands.'},
{id:'ro',name:'Romania',region:'Europe',scripts:['latin'],drive:'right',plates:['eu'],marks:['white-center'],poles:['concrete'],arch:['soviet','old-town'],veg:['temperate'],terrain:['mountains','rural'],street:['tram'],tell:'Carpathians, painted monasteries region, EU plates.'},
{id:'bg',name:'Bulgaria',region:'Europe',scripts:['cyrillic'],drive:'right',plates:['eu'],marks:['white-center'],poles:['concrete'],arch:['soviet','old-town'],veg:['temperate'],terrain:['mountains','coast'],street:[],tell:'Cyrillic signs, panelki estates, Black Sea coast.'},
{id:'gr',name:'Greece',region:'Europe',scripts:['greek','latin'],drive:'right',plates:['eu'],marks:['white-center'],poles:['concrete'],arch:['mediterranean','whitewashed','old-town'],veg:['scrub'],terrain:['coast','mountains'],street:[],tell:'Whitewash + blue domes, Greek-script signs.'},
{id:'ru',name:'Russia',region:'Europe/Asia',scripts:['cyrillic'],drive:'right',plates:['plain'],marks:['white-center'],poles:['concrete','wooden'],arch:['soviet','brutalist'],veg:['boreal','temperate'],terrain:['snow','rural'],street:['tram'],tell:'Cyrillic, region-code plates, marshrutka vans.'},
{id:'ua',name:'Ukraine',region:'Europe',scripts:['cyrillic'],drive:'right',plates:['eu'],marks:['white-center'],poles:['concrete'],arch:['soviet','old-town'],veg:['temperate'],terrain:['rural'],street:['tram'],tell:'Blue-band UA plates, Cyrillic, khrushchyovka blocks.'},
{id:'rs',name:'Serbia',region:'Europe',scripts:['cyrillic','latin'],drive:'right',plates:['eu'],marks:['white-center'],poles:['concrete'],arch:['soviet','old-town'],veg:['temperate'],terrain:['mountains'],street:['tram'],tell:'Dual-script signs (Cyrillic official), SRB plates.'},
{id:'hr',name:'Croatia',region:'Europe',scripts:['latin'],drive:'right',plates:['eu'],marks:['white-center'],poles:['concrete'],arch:['mediterranean','old-town'],veg:['scrub'],terrain:['coast','mountains'],street:[],tell:'Dalmatian stone towns, EU plates, Adriatic.'},
{id:'tr',name:'Türkiye',region:'Europe/Asia',scripts:['latin'],drive:'right',plates:['plain'],marks:['white-center'],poles:['concrete'],arch:['islamic','old-town','mediterranean'],veg:['scrub','desert'],terrain:['coast','mountains'],street:[],tell:'Minarets, Turkish flags, blue-white plates.'},
{id:'jp',name:'Japan',region:'Asia',scripts:['cjk','latin'],drive:'left',plates:['jp'],marks:['white-center'],poles:['dense-wires'],arch:['east-asian'],veg:['temperate','alpine'],terrain:['mountains','coast'],street:['keicar'],tell:'Dense overhead wires, kanji signs, kei cars, vending machines.'},
{id:'kr',name:'South Korea',region:'Asia',scripts:['hangul','latin'],drive:'right',plates:['plain'],marks:['yellow-center'],poles:['concrete'],arch:['east-asian','skyscraper'],veg:['temperate'],terrain:['mountains','urban'],street:[],tell:'Hangul everywhere, yellow center lines, dense high-rises.'},
{id:'cn',name:'China',region:'Asia',scripts:['cjk'],drive:'right',plates:['plain'],marks:['yellow-center'],poles:['dense-wires'],arch:['east-asian','skyscraper','soviet'],veg:['temperate','desert','jungle'],terrain:['mountains','urban','rural'],street:['scooters','bikes'],tell:'Simplified characters, blue plates, e-bike swarms.'},
{id:'tw',name:'Taiwan',region:'Asia',scripts:['cjk','latin'],drive:'right',plates:['plain'],marks:['yellow-center'],poles:['dense-wires'],arch:['east-asian'],veg:['palms','jungle'],terrain:['mountains','coast'],street:['scooters'],tell:'Traditional characters, scooter waterfalls, night markets.'},
{id:'th',name:'Thailand',region:'Asia',scripts:['thai','latin'],drive:'left',plates:['plain'],marks:['white-center','yellow-center'],poles:['dense-wires'],arch:['east-asian','tropical-stilt'],veg:['palms','jungle'],terrain:['coast'],street:['tuktuk','scooters'],tell:'Thai script, tuk-tuks, spirit houses, sois.'},
{id:'vn',name:'Vietnam',region:'Asia',scripts:['latin'],drive:'right',plates:['plain'],marks:['yellow-center'],poles:['dense-wires'],arch:['east-asian','colonial','tropical-stilt'],veg:['jungle','paddy','palms'],terrain:['coast','rural'],street:['scooters'],tell:'Vietnamese diacritics, motorbike rivers, tube houses.'},
{id:'id',name:'Indonesia',region:'Asia',scripts:['latin'],drive:'left',plates:['plain'],marks:['white-center'],poles:['dense-wires'],arch:['islamic','tropical-stilt'],veg:['jungle','palms'],terrain:['coast','mountains'],street:['scooters'],tell:'Black plates, mosques, volcanic peaks, warungs.'},
{id:'my',name:'Malaysia',region:'Asia',scripts:['latin'],drive:'left',plates:['plain'],marks:['white-center'],poles:['concrete'],arch:['islamic','colonial','skyscraper'],veg:['jungle','palms'],terrain:['coast','urban'],street:[],tell:'Drive left, Jawi script on official signs, KL towers.'},
{id:'ph',name:'Philippines',region:'Asia',scripts:['latin'],drive:'right',plates:['plain'],marks:['yellow-center'],poles:['dense-wires','wooden'],arch:['colonial','tropical-stilt'],veg:['palms','jungle'],terrain:['coast'],street:['tuktuk'],tell:'Jeepneys, tricycles, English signage, basketball hoops.'},
{id:'in',name:'India',region:'Asia',scripts:['latin','devanagari'],drive:'left',plates:['plain'],marks:['white-center'],poles:['dense-wires'],arch:['colonial','islamic'],veg:['jungle','desert','palms'],terrain:['mountains','urban','rural'],street:['tuktuk','scooters'],tell:'Auto-rickshaws, IND-font plates, chai stalls, chaos.'},
{id:'pk',name:'Pakistan',region:'Asia',scripts:['arabic','latin'],drive:'left',plates:['plain'],marks:['white-center'],poles:['concrete'],arch:['islamic','colonial'],veg:['desert'],terrain:['mountains','desert-land'],street:[],tell:'Urdu (Arabic script), decorated trucks, drive left.'},
{id:'il',name:'Israel',region:'Asia',scripts:['hebrew','arabic','latin'],drive:'right',plates:['yellow'],marks:['white-center'],poles:['concrete'],arch:['mediterranean','old-town'],veg:['desert','scrub'],terrain:['coast','desert-land'],street:[],tell:'Yellow plates, trilingual signs, white Bauhaus Tel Aviv.'},
{id:'ae',name:'UAE',region:'Asia',scripts:['arabic','latin'],drive:'right',plates:['plain'],marks:['white-center','yellow-center'],poles:['buried'],arch:['islamic','skyscraper'],veg:['desert'],terrain:['desert-land','coast','urban'],street:[],tell:'Emirate-coded plates, supertalls, desert highways.'},
{id:'sa',name:'Saudi Arabia',region:'Asia',scripts:['arabic'],drive:'right',plates:['arabic-num'],marks:['white-center'],poles:['concrete'],arch:['islamic'],veg:['desert'],terrain:['desert-land'],street:[],tell:'Arabic-numeral plates, desert, mosque architecture.'},
{id:'kz',name:'Kazakhstan',region:'Asia',scripts:['cyrillic','latin'],drive:'right',plates:['plain'],marks:['white-center'],poles:['concrete'],arch:['soviet','islamic','skyscraper'],veg:['desert'],terrain:['desert-land','mountains','rural'],street:[],tell:'Cyrillic + Latin transition signs, endless steppe.'},
{id:'ge',name:'Georgia',region:'Asia',scripts:['georgian','latin'],drive:'right',plates:['eu'],marks:['white-center'],poles:['concrete','wooden'],arch:['old-town','soviet'],veg:['temperate','alpine'],terrain:['mountains'],street:[],tell:'Unique curly Georgian script, Caucasus peaks.'},
{id:'us',name:'United States',region:'Americas',scripts:['latin'],drive:'right',plates:['us'],marks:['yellow-center'],poles:['wooden'],arch:['us-suburb','colonial','art-deco','skyscraper'],veg:['temperate','desert','palms'],terrain:['mountains','coast','desert-land','urban','rural'],street:['pickup','schoolbus','taxi-yellow'],tell:'Yellow center lines, wooden poles, state plates, strip malls.'},
{id:'ca',name:'Canada',region:'Americas',scripts:['latin'],drive:'right',plates:['plain'],marks:['yellow-center'],poles:['wooden'],arch:['us-suburb','colonial'],veg:['boreal','temperate','alpine'],terrain:['mountains','snow','rural'],street:['pickup'],tell:'Like the US but metric signs, bilingual in Québec.'},
{id:'mx',name:'Mexico',region:'Americas',scripts:['latin'],drive:'right',plates:['plain'],marks:['yellow-center'],poles:['concrete'],arch:['colonial','adobe'],veg:['desert','jungle','palms'],terrain:['mountains','coast','desert-land'],street:['pickup'],tell:'Vibrant painted facades, topes (speed bumps), VW Beetle taxis.'},
{id:'br',name:'Brazil',region:'Americas',scripts:['latin'],drive:'right',plates:['mercosur'],marks:['yellow-center'],poles:['concrete','wooden'],arch:['colonial','tropical-stilt','brutalist'],veg:['jungle','palms','savanna'],terrain:['coast','urban'],street:[],tell:'Mercosur plates, Portuguese, favelas on hillsides.'},
{id:'ar',name:'Argentina',region:'Americas',scripts:['latin'],drive:'right',plates:['mercosur'],marks:['white-center','yellow-center'],poles:['concrete'],arch:['colonial','old-town'],veg:['temperate','desert'],terrain:['mountains','rural','snow'],street:[],tell:'Mercosur plates, Parisian avenues, pampas, Andes.'},
{id:'cl',name:'Chile',region:'Americas',scripts:['latin'],drive:'right',plates:['plain'],marks:['yellow-center'],poles:['wooden'],arch:['colonial'],veg:['desert','temperate'],terrain:['mountains','coast','desert-land'],street:[],tell:'Long thin country, Atacama desert, Andes backdrop.'},
{id:'co',name:'Colombia',region:'Americas',scripts:['latin'],drive:'right',plates:['yellow'],marks:['yellow-center'],poles:['concrete'],arch:['colonial'],veg:['jungle','palms'],terrain:['mountains','coast'],street:[],tell:'Yellow plates, green Andes, colonial old towns.'},
{id:'pe',name:'Peru',region:'Americas',scripts:['latin'],drive:'right',plates:['plain'],marks:['yellow-center'],poles:['concrete'],arch:['colonial','adobe'],veg:['desert','jungle'],terrain:['mountains','coast','desert-land'],street:['tuktuk'],tell:'Andes, coastal desert, mototaxis, Inca stone walls.'},
{id:'za',name:'South Africa',region:'Africa',scripts:['latin'],drive:'left',plates:['plain'],marks:['white-center','yellow-center'],poles:['wooden'],arch:['colonial'],veg:['savanna','desert','scrub'],terrain:['coast','mountains','rural'],street:[],tell:'Drive left, 11 official languages on signs, minibus taxis.'},
{id:'eg',name:'Egypt',region:'Africa',scripts:['arabic','latin'],drive:'right',plates:['arabic-num'],marks:['white-center'],poles:['concrete'],arch:['islamic','old-town'],veg:['desert'],terrain:['desert-land','coast','urban'],street:[],tell:'Arabic-numeral plates, desert, minarets, Nile.'},
{id:'ma',name:'Morocco',region:'Africa',scripts:['arabic','latin'],drive:'right',plates:['plain'],marks:['white-center'],poles:['concrete'],arch:['islamic','mediterranean','old-town'],veg:['desert','scrub'],terrain:['desert-land','coast','mountains'],street:[],tell:'Arabic + French signs, medinas, Atlas mountains.'},
{id:'ke',name:'Kenya',region:'Africa',scripts:['latin'],drive:'left',plates:['plain'],marks:['white-center'],poles:['wooden'],arch:['colonial'],veg:['savanna'],terrain:['rural'],street:[],tell:'Drive left, matatus, acacia savanna, white plates.'},
{id:'ng',name:'Nigeria',region:'Africa',scripts:['latin'],drive:'right',plates:['plain'],marks:['white-center'],poles:['concrete'],arch:['colonial'],veg:['jungle','savanna'],terrain:['urban','rural'],street:[],tell:'Drive right, danfo buses, green-white-green flags.'},
{id:'au',name:'Australia',region:'Oceania',scripts:['latin'],drive:'left',plates:['plain'],marks:['white-center'],poles:['wooden'],arch:['colonial'],veg:['desert','scrub','palms'],terrain:['coast','desert-land','rural'],street:[],tell:'Drive left, outback red dirt, Queenslander houses.'},
{id:'nz',name:'New Zealand',region:'Oceania',scripts:['latin'],drive:'left',plates:['plain'],marks:['white-center'],poles:['wooden'],arch:['colonial'],veg:['temperate','alpine'],terrain:['mountains','coast','snow','rural'],street:[],tell:'Drive left, bilingual Māori signs, Southern Alps.'},
];

// ---------------------------------------------------------------------------
// Cue definitions. w = weight. hard = strong penalty on mismatch.
// field: country attribute to test; val: cue value. Scalar fields (drive)
// compare with ===, array fields with includes().
// ---------------------------------------------------------------------------
const SCRIPT_W = 6, DRIVE_W = 10, PLATE_W = 3, MARK_W = 2.5, POLE_W = 2,
      ARCH_W = 2, VEG_W = 1.5, TERRAIN_W = 1, STREET_W = 2;

function mkCue(group, id, label, field, val, w, hard, hint) {
  return { group, id, label, field, val, w, hard: !!hard, hint: hint || '' };
}

export const CUES = [
  // scripts
  mkCue('Writing on signs','script-latin','Latin alphabet','scripts','latin',SCRIPT_W,false),
  mkCue('Writing on signs','script-cyrillic','Cyrillic','scripts','cyrillic',SCRIPT_W,true,'Russia, Ukraine, Bulgaria, Serbia, Central Asia'),
  mkCue('Writing on signs','script-arabic','Arabic script','scripts','arabic',SCRIPT_W,true,'Middle East, North Africa, Pakistan, Iran'),
  mkCue('Writing on signs','script-cjk','Chinese characters / kanji','scripts','cjk',SCRIPT_W,true,'China, Japan, Taiwan (traditional in TW/JP)'),
  mkCue('Writing on signs','script-devanagari','Devanagari','scripts','devanagari',SCRIPT_W,true,'India, Nepal'),
  mkCue('Writing on signs','script-thai','Thai script','scripts','thai',SCRIPT_W,true,'Thailand, Laos'),
  mkCue('Writing on signs','script-hangul','Korean hangul','scripts','hangul',SCRIPT_W,true,'South Korea'),
  mkCue('Writing on signs','script-hebrew','Hebrew','scripts','hebrew',SCRIPT_W,true,'Israel'),
  mkCue('Writing on signs','script-greek','Greek alphabet','scripts','greek',SCRIPT_W,true,'Greece, Cyprus'),
  mkCue('Writing on signs','script-georgian','Georgian script','scripts','georgian',SCRIPT_W,true,'Georgia only — curly unique letters'),
  // drive side
  mkCue('Driving','drive-left','Driving on the LEFT','drive','left',DRIVE_W,true,'UK, Japan, Australia, India, Thailand, southern Africa…'),
  mkCue('Driving','drive-right','Driving on the RIGHT','drive','right',DRIVE_W,true,'Most of the world'),
  // plates
  mkCue('License plates','plate-eu','EU blue band on the left','plates','eu',PLATE_W,true),
  mkCue('License plates','plate-uk','White front / yellow rear (UK style)','plates','uk',PLATE_W,true),
  mkCue('License plates','plate-us','US state plate','plates','us',PLATE_W,true),
  mkCue('License plates','plate-jp','Japanese plate (kanji + classification)','plates','jp',PLATE_W,true),
  mkCue('License plates','plate-mercosur','Mercosur plate (blue band top)','plates','mercosur',PLATE_W,true,'Brazil, Argentina, Uruguay, Paraguay'),
  mkCue('License plates','plate-yellow','Yellow plate','plates','yellow',PLATE_W,false,'Netherlands, Israel, Colombia…'),
  mkCue('License plates','plate-arabicnum','Arabic-Indic numerals on plate','plates','arabic-num',PLATE_W,true,'Saudi, Egypt…'),
  // road markings
  mkCue('Road markings','mark-yellow','YELLOW center line','marks','yellow-center',MARK_W,false,'Americas, Korea, China…'),
  mkCue('Road markings','mark-white','WHITE center line / lane lines','marks','white-center',MARK_W,false,'Most of Europe, UK, Japan…'),
  // utility poles
  mkCue('Utility poles','pole-wires','Dense overhead wire tangles','poles','dense-wires',POLE_W,false,'Japan, SE Asia, Latin America'),
  mkCue('Utility poles','pole-wooden','Wooden poles','poles','wooden',POLE_W,false,'North America, Nordics, rural areas'),
  mkCue('Utility poles','pole-concrete','Concrete poles','poles','concrete',POLE_W,false,'Continental Europe, much of Asia/Africa'),
  mkCue('Utility poles','pole-uk','UK-style telegraph poles','poles','uk-telegraph',POLE_W,false),
  mkCue('Utility poles','pole-buried','No poles — cables buried','poles','buried',POLE_W,false,'Germany, Netherlands, Gulf states'),
  // architecture
  mkCue('Architecture','arch-oldtown','European old town','arch','old-town',ARCH_W,false),
  mkCue('Architecture','arch-soviet','Soviet-bloc blocks','arch','soviet',ARCH_W,false,'Eastern Europe, Russia, Central Asia'),
  mkCue('Architecture','arch-med','Mediterranean','arch','mediterranean',ARCH_W,false),
  mkCue('Architecture','arch-islamic','Islamic / mosque architecture','arch','islamic',ARCH_W,false),
  mkCue('Architecture','arch-eastasian','East Asian temples / roofs','arch','east-asian',ARCH_W,false),
  mkCue('Architecture','arch-ussuburb','US suburb / strip mall','arch','us-suburb',ARCH_W,false),
  mkCue('Architecture','arch-nordic','Nordic wooden houses','arch','nordic-wood',ARCH_W,false),
  mkCue('Architecture','arch-colonial','Colonial-era buildings','arch','colonial',ARCH_W,false),
  mkCue('Architecture','arch-stilt','Tropical stilt houses','arch','tropical-stilt',ARCH_W,false),
  mkCue('Architecture','arch-skyscraper','Glass skyscraper cluster','arch','skyscraper',ARCH_W,false),
  mkCue('Architecture','arch-whitewash','Whitewashed cubic houses','arch','whitewashed',ARCH_W,false,'Greece, Andalusia…'),
  mkCue('Architecture','arch-adobe','Adobe / mud-brick','arch','adobe',ARCH_W,false,'Mexico, Peru, US Southwest…'),
  mkCue('Architecture','arch-brutalist','Brutalist concrete','arch','brutalist',ARCH_W,false),
  // vegetation
  mkCue('Vegetation','veg-palms','Palm trees','veg','palms',VEG_W,false),
  mkCue('Vegetation','veg-desert','Arid / desert scrub','veg','desert',VEG_W,false),
  mkCue('Vegetation','veg-temperate','Lush temperate green','veg','temperate',VEG_W,false),
  mkCue('Vegetation','veg-alpine','Conifer / alpine forest','veg','alpine',VEG_W,false),
  mkCue('Vegetation','veg-jungle','Dense jungle','veg','jungle',VEG_W,false),
  mkCue('Vegetation','veg-savanna','Savanna / acacia','veg','savanna',VEG_W,false),
  mkCue('Vegetation','veg-scrub','Mediterranean scrub / olive','veg','scrub',VEG_W,false),
  mkCue('Vegetation','veg-boreal','Boreal pine / birch','veg','boreal',VEG_W,false),
  mkCue('Vegetation','veg-paddy','Rice paddies','veg','paddy',VEG_W,false),
  // terrain
  mkCue('Setting','terr-mountains','Mountains','terrain','mountains',TERRAIN_W,false),
  mkCue('Setting','terr-coast','Coast / beach','terrain','coast',TERRAIN_W,false),
  mkCue('Setting','terr-desert','Desert landscape','terrain','desert-land',TERRAIN_W,false),
  mkCue('Setting','terr-urban','Dense urban','terrain','urban',TERRAIN_W,false),
  mkCue('Setting','terr-rural','Rural fields','terrain','rural',TERRAIN_W,false),
  mkCue('Setting','terr-snow','Snow on the ground','terrain','snow',TERRAIN_W,true,'Strong seasonal signal'),
  // street details
  mkCue('Street details','st-tuktuk','Tuk-tuks / rickshaws','street','tuktuk',STREET_W,false),
  mkCue('Street details','st-taxiyellow','Yellow taxis','street','taxi-yellow',STREET_W,false,'NYC-style — US, some Latin America'),
  mkCue('Street details','st-blackcab','Black cabs','street','blackcab',STREET_W,true,'London tell'),
  mkCue('Street details','st-keicar','Kei cars (tiny boxy cars)','street','keicar',STREET_W,true,'Japan tell'),
  mkCue('Street details','st-pickup','Pickup trucks everywhere','street','pickup',STREET_W,false,'US, Canada, Mexico, Thailand…'),
  mkCue('Street details','st-scooters','Scooter / motorbike swarms','street','scooters',STREET_W,false,'SE Asia, Taiwan, Italy, India…'),
  mkCue('Street details','st-bikes','Bicycles everywhere','street','bikes',STREET_W,false,'Netherlands, Denmark, China, Vietnam…'),
  mkCue('Street details','st-phonebox','Red phone boxes','street','phonebox',STREET_W,true,'UK tell'),
  mkCue('Street details','st-doubledecker','Double-decker buses','street','doubledecker',STREET_W,false,'UK, Hong Kong…'),
  mkCue('Street details','st-schoolbus','Yellow school buses','street','schoolbus',STREET_W,true,'US/Canada tell'),
  mkCue('Street details','st-tram','Trams / streetcars','street','tram',STREET_W,false,'Much of Europe…'),
];

export const CUE_BY_ID = Object.fromEntries(CUES.map(c => [c.id, c]));
export const CUE_GROUPS = [...new Set(CUES.map(c => c.group))];

// ---------------------------------------------------------------------------
// Scoring engine.
// selectedIds: array of cue ids the user confirmed.
// Returns ranked array: {country, score, max, pct, matched:[labels], missed:[labels]}
// ---------------------------------------------------------------------------
export function scoreCues(selectedIds) {
  const cues = selectedIds.map(id => CUE_BY_ID[id]).filter(Boolean);
  const max = cues.reduce((s, c) => s + c.w, 0);
  const out = COUNTRIES.map(ct => {
    let score = 0;
    const matched = [], missed = [];
    for (const cue of cues) {
      const v = ct[cue.field];
      const hit = Array.isArray(v) ? v.includes(cue.val) : v === cue.val;
      if (hit) { score += cue.w; matched.push(cue.label); }
      else {
        const pen = cue.hard ? cue.w * 1.5 : cue.w * 0.5;
        score -= pen; missed.push(cue.label);
      }
    }
    const pct = max > 0 ? Math.max(0, Math.round((score / max) * 100)) : 0;
    return { country: ct, score: Math.round(score * 10) / 10, max, pct, matched, missed };
  });
  out.sort((a, b) => b.score - a.score || b.pct - a.pct);
  return out;
}

// Region rollup: sum of top-half scores per region (clamped at 0).
export function regionRollup(ranked) {
  const half = Math.max(1, Math.floor(ranked.length / 2));
  const sums = {};
  for (const r of ranked.slice(0, half)) {
    const rg = r.country.region;
    sums[rg] = (sums[rg] || 0) + Math.max(0, r.score);
  }
  const total = Object.values(sums).reduce((a, b) => a + b, 0) || 1;
  return Object.entries(sums)
    .map(([region, s]) => ({ region, pct: Math.round((s / total) * 100) }))
    .sort((a, b) => b.pct - a.pct);
}

// ---------------------------------------------------------------------------
// Minimal EXIF parser (JPEG APP1). Pure: takes Uint8Array of the file.
// Returns {lat, lon, datetime, make, model} — nulls where absent.
// ---------------------------------------------------------------------------
function readU16(dv, off, le) { return dv.getUint16(off, le); }
function readU32(dv, off, le) { return dv.getUint32(off, le); }
function readIFD(dv, tiffStart, ifdOff, le, out) {
  const n = readU16(dv, tiffStart + ifdOff, le);
  for (let i = 0; i < n; i++) {
    const e = tiffStart + ifdOff + 2 + i * 12;
    const tag = readU16(dv, e, le);
    const type = readU16(dv, e + 2, le);
    const count = readU32(dv, e + 4, le);
    const valOff = e + 8;
    const unit = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }[type] || 1;
    const byteLen = unit * count;
    const dataAt = byteLen <= 4 ? valOff : tiffStart + readU32(dv, valOff, le);
    out.push({ tag, type, count, at: dataAt });
  }
  return readU32(dv, tiffStart + ifdOff + 2 + n * 12, le); // next IFD offset
}
function ascii(dv, at, count) {
  let s = '';
  for (let i = 0; i < count; i++) {
    const c = dv.getUint8(at + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}
function rational(dv, at, le) {
  const n = readU32(dv, at, le), d = readU32(dv, at + 4, le);
  return d === 0 ? 0 : n / d;
}
function dmsToDeg(dv, at, le) {
  return rational(dv, at, le) + rational(dv, at + 8, le) / 60 + rational(dv, at + 16, le) / 3600;
}

export function parseExif(bytes) {
  const out = { lat: null, lon: null, datetime: null, make: null, model: null, hasExif: false };
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint8(0) !== 0xFF || dv.getUint8(1) !== 0xD8) return out; // not JPEG
    let off = 2;
    while (off + 4 < bytes.length) {
      if (dv.getUint8(off) !== 0xFF) break;
      const marker = dv.getUint8(off + 1);
      if (marker === 0xD9 || marker === 0xDA) break; // EOI / SOS
      const len = dv.getUint16(off + 2, false);
      if (marker === 0xE1) { // APP1 — maybe Exif
        const head = ascii(dv, off + 4, 4);
        if (head === 'Exif') {
          out.hasExif = true;
          const tiff = off + 10;
          const bo = ascii(dv, tiff, 2);
          const le = bo === 'II';
          if (!le && bo !== 'MM') return out;
          if (readU16(dv, tiff + 2, le) !== 42) return out;
          const ifd0 = readU32(dv, tiff + 4, le);
          const entries = [];
          readIFD(dv, tiff, ifd0, le, entries);
          let gpsIfd = null, exifIfd = null;
          for (const en of entries) {
            if (en.tag === 0x010F) out.make = ascii(dv, en.at, en.count).trim();
            if (en.tag === 0x0110) out.model = ascii(dv, en.at, en.count).trim();
            if (en.tag === 0x8825) gpsIfd = readU32(dv, en.at, le);
            if (en.tag === 0x8769) exifIfd = readU32(dv, en.at, le);
          }
          if (exifIfd != null) {
            const sub = [];
            readIFD(dv, tiff, exifIfd, le, sub);
            for (const en of sub) {
              if (en.tag === 0x9003 || en.tag === 0x0132) {
                const dt = ascii(dv, en.at, en.count).trim();
                if (dt && !out.datetime) out.datetime = dt;
              }
            }
          }
          if (gpsIfd != null) {
            const g = [];
            readIFD(dv, tiff, gpsIfd, le, g);
            let latRef = 'N', lonRef = 'E', latAt = null, lonAt = null;
            for (const en of g) {
              if (en.tag === 0x0001) latRef = ascii(dv, en.at, en.count);
              if (en.tag === 0x0002) latAt = en.at;
              if (en.tag === 0x0003) lonRef = ascii(dv, en.at, en.count);
              if (en.tag === 0x0004) lonAt = en.at;
            }
            if (latAt != null) {
              out.lat = dmsToDeg(dv, latAt, le) * (latRef === 'S' ? -1 : 1);
              out.lat = Math.round(out.lat * 1e6) / 1e6;
            }
            if (lonAt != null) {
              out.lon = dmsToDeg(dv, lonAt, le) * (lonRef === 'W' ? -1 : 1);
              out.lon = Math.round(out.lon * 1e6) / 1e6;
            }
          }
          return out;
        }
      }
      off += 2 + len;
    }
  } catch (e) { /* malformed — return what we have */ }
  return out;
}

// ---------------------------------------------------------------------------
// Pixel heuristics. Pure: takes {data: Uint8ClampedArray|Array, width, height}
// (RGBA). Returns 0..1 fractions + flags.
// ---------------------------------------------------------------------------
export function analyzePixels(img) {
  const { data, width, height } = img;
  const n = width * height;
  let green = 0, sky = 0, skyN = 0, warmSum = 0, lumSum = 0, greenN = 0;
  const topEnd = Math.floor(n / 3);           // top third: sky zone
  const botStart = Math.floor(n / 3);         // lower two-thirds: vegetation zone
  for (let i = 0; i < n; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    lumSum += lum;
    warmSum += (r - b) / 255;
    if (i < topEnd) {
      skyN++;
      if (b > r + 30 && b > g + 10) sky++;
    }
    if (i >= botStart) {
      greenN++;
      if (g > r + 20 && g > b + 10) green++;
    }
  }
  const veg = greenN ? green / greenN : 0;
  const skyFrac = skyN ? sky / skyN : 0;
  const bright = lumSum / n;
  const warm = warmSum / n;
  return {
    veg: Math.round(veg * 100) / 100,          // vegetation density 0..1
    sky: Math.round(skyFrac * 100) / 100,      // blue-sky presence 0..1
    bright: Math.round(bright * 100) / 100,    // mean luminance 0..1
    warm: Math.round(warm * 100) / 100,        // >0 warm, <0 cool
    night: bright < 0.12,                      // heuristic night threshold
  };
}

// Suggested auto-cues from heuristics (user confirms — never auto-applied).
export function suggestCues(h) {
  const s = [];
  if (h.night) s.push({ id: 'auto-night', label: 'Night shot — shadows/sun unavailable', cue: null });
  if (h.veg > 0.35) s.push({ id: 'auto-veg', label: `Heavy vegetation (${Math.round(h.veg * 100)}% green)`, cues: ['veg-jungle', 'veg-palms', 'veg-temperate'] });
  else if (h.veg > 0.15) s.push({ id: 'auto-veg', label: `Moderate vegetation (${Math.round(h.veg * 100)}% green)`, cues: ['veg-temperate', 'veg-scrub', 'veg-savanna'] });
  if (h.sky > 0.4) s.push({ id: 'auto-sky', label: `Clear blue sky (${Math.round(h.sky * 100)}% of upper frame)`, cues: [] });
  if (!h.night && h.bright > 0.55 && h.warm > 0.08) s.push({ id: 'auto-sun', label: 'Harsh warm sunlight', cues: ['veg-desert', 'veg-scrub', 'veg-palms'] });
  return s;
}

// ---------------------------------------------------------------------------
// Landmark lookup (network). Fires automatically when GPS coordinates exist.
// Wikidata: named places with coordinates near the photo, ranked by distance.
// Nominatim: human-readable place name for the coordinates.
// Both are free, keyless, CORS-enabled. Failures resolve to null — never throw.
// ---------------------------------------------------------------------------
function fetchJson(url, ms, extraHeaders) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  // NOTE: browsers ignore a manual User-Agent (forbidden header) and send
  // their own, which is fine. In node the UA below keeps Wikidata/Nominatim happy.
  const headers = Object.assign({ 'Accept': 'application/json', 'User-Agent': 'GEOSLEUTH/1.0 (photo location tool)' }, extraHeaders);
  return fetch(url, { signal: c.signal, headers })
    .then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
    .finally(() => clearTimeout(t));
}

// Named places near (lat, lon), closest first. Prefers entries with a photo
// or a Wikipedia article — those are the recognizable landmarks, not random
// address nodes. Resolves to an array (possibly empty) or null on failure.
export async function nearbyLandmarks(lat, lon, radiusKm = 10, limit = 12) {
  const around = `SERVICE wikibase:around {
    ?item wdt:P625 ?coord.
    bd:serviceParam wikibase:center "Point(${lon} ${lat})"^^geo:wktLiteral.
    bd:serviceParam wikibase:radius "${radiusKm}".
    bd:serviceParam wikibase:distance ?dist.
  }`;
  const strict = `SELECT ?item ?itemLabel ?coord ?dist ?image ?article WHERE {
  ${around}
  OPTIONAL { ?item wdt:P18 ?image. }
  OPTIONAL { ?article schema:about ?item; schema:isPartOf <https://en.wikipedia.org/>. }
  FILTER(BOUND(?image) || BOUND(?article))
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY ?dist
LIMIT 60`;
  const loose = strict.replace('FILTER(BOUND(?image) || BOUND(?article))\n  ', '');
  let rows = await sparqlRows(strict);
  if (rows === null) return null;                    // service down — not "no results"
  if (rows.length < 3) rows = await sparqlRows(loose) || rows;
  const out = [];
  for (const b of rows) {
    const name = b.itemLabel && b.itemLabel.value;
    const m = b.coord && /^Point\(([-\d.]+) ([-\d.]+)\)$/.exec(b.coord.value);
    if (!name || !m || /^Q\d+$/.test(name)) continue;
    const qid = b.item.value.split('/').pop();
    out.push({
      qid, name,
      distKm: b.dist ? +(+b.dist.value).toFixed(2) : null,
      lat: +m[2], lon: +m[1],
      image: b.image ? b.image.value : null,
      article: b.article ? b.article.value : null,
      wikidataUrl: 'https://www.wikidata.org/wiki/' + qid,
    });
  }
  // recognizable first (photo or article), then by distance
  out.sort((a, b) => ((b.image || b.article) ? 0 : 1) - ((a.image || a.article) ? 0 : 1)
    || (a.distKm ?? 1e9) - (b.distKm ?? 1e9));
  return out.slice(0, limit);
}

async function sparqlRows(q) {
  const url = 'https://query.wikidata.org/sparql?query=' + encodeURIComponent(q) + '&format=json';
  let data;
  try { data = await fetchJson(url, 30000); }
  catch (e) { return null; }
  return (data.results && data.results.bindings) || [];
}

// Human-readable place name for coordinates ("Shibuya, Tokyo, Japan").
// Resolves to { label, city, country } or null on failure.
export async function reverseGeocode(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=jsonv2&zoom=14`;
  let d;
  try { d = await fetchJson(url, 30000); }
  catch (e) { return null; }
  if (!d || !d.display_name) return null;
  const a = d.address || {};
  return {
    label: d.display_name.split(',').slice(0, 4).join(','),
    city: a.city || a.town || a.village || a.suburb || a.county || null,
    country: a.country || null,
  };
}
