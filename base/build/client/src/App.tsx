import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import {
  api,
  clearAdminCode,
  clearSchoolCode,
  getAdminCode,
  getSchoolCode,
  setAdminCode,
  setSchoolCode,
  type ApiResponse,
} from "./api";
import { RiderTapLogo } from "./RiderTapLogo";

type State = ApiResponse<typeof api, "getState">;
type Entry = State["entries"][number];
type School = NonNullable<State["school"]>;
type AdminOverview = ApiResponse<typeof api, "adminOverview">;
type AdminSchool = AdminOverview["schools"][number];
type Lang = "en" | "es";
type View = "walker" | "board" | "loader" | "office" | "setup" | "help";

const T = {
  en: {
    walker: "Enter Numbers",
    board: "Board",
    loader: "Load Cars",
    office: "Office",
    setup: "Setup",
    help: "Help",
    helpButton: "HELP — How It Works",
    tagline: "Tap the number. Move the line.",
    leftLine: "LEFT LINE",
    rightLine: "RIGHT LINE",
    addCar: "ADD CAR",
    undo: "UNDO LAST",
    clear: "Clear",
    alreadyCalled: "ALREADY CALLED",
    holdAlert: "ON HOLD — DO NOT RELEASE — SEE OFFICE",
    added: "added",
    wave: "Wave",
    spot: "Spot",
    noCarsYet: "No cars yet today. Numbers you enter appear here and on the Board.",
    recent: "Just entered",
    onBoard: "On Board",
    atSpot: "At Spot",
    markLoaded: "Loaded ✓",
    noShow: "No Show",
    releaseWave: "RELEASE WAVE",
    ready: "ready",
    waitingCars: "Still Waiting",
    waitingHelp: "Every number entered but not loaded or departed. Check this list before ending dismissal.",
    nobodyWaiting: "Nobody waiting — every car is loaded or departed.",
    holds: "Holds",
    holdsHelp: "A hold needs no reason. Nothing about why is stored. Held cars cannot be loaded.",
    holdNumberPlaceholder: "Tag number",
    setHold: "SET HOLD",
    clearHold: "CLEAR",
    endDismissal: "END DISMISSAL",
    endConfirm: "Tap again to end dismissal and clear today's numbers",
    daySummary: "Today's summary",
    carsLoaded: "Cars loaded",
    wavesRun: "Waves run",
    noShows: "No shows",
    firstCar: "First car",
    lastCar: "Last car out",
    numbersCleared: "Today's numbers have been cleared. Only this summary is kept.",
    proofReport: "Principal's Proof Report",
    proofLatest: "Latest dismissal",
    proofSemester: "This semester",
    proofHistory: "History",
    proofEmpty: "No completed dismissals yet — your first report appears after End Dismissal",
    avgDismissal: "Average dismissal",
    fastestDay: "Fastest day",
    totalCarsMoved: "Total cars moved",
    daysRecorded: "Days recorded",
    holdsPlacedLabel: "Holds placed",
    stillWaitingLabel: "still waiting",
    dismissalComplete: "Dismissal complete",
    inWord: "in",
    carWord: "car",
    carsWord: "cars",
    waveWord: "wave",
    wavesWord: "waves",
    noShowWord: "no-shows",
    under1Min: "under 1 min",
    trendIs: "Dismissal is",
    minWord: "min",
    trendFaster: "faster than your first week",
    trendSlower: "slower than your first week",
    trendSame: "Dismissal is about the same as your first week",
    setupTitle: "School setup",
    schoolName: "School name",
    district: "District",
    county: "County",
    state: "State",
    schoolType: "School type",
    elementary: "Elementary",
    middle: "Middle",
    high: "High",
    elementaryShort: "ES",
    middleShort: "MS",
    highShort: "HS",
    elementaryFull: "Elementary School",
    middleFull: "Middle School",
    highFull: "High School",
    selectedType: "Selected",
    start: "Dismissal start",
    end: "Dismissal end",
    spots: "Loading spots per wave",
    laneConfig: "How does your line run?",
    singleFile: "Single File",
    twoLines: "Two Lines — Left / Right",
    leftLabel: "Left lane name",
    rightLabel: "Right lane name",
    save: "SAVE SETUP",
    saved: "Saved ✓",
    resetDemo: "Change school code",
    loadDemo: "Load the demo school",
    noSchool: "No school is set up yet.",
    joinTitle: "Enter your school code",
    joinHelp:
      "One code for your whole dismissal team. Enter it once on each staff phone.",
    joinPlaceholder: "SCHOOL CODE",
    joinButton: "OPEN RIDERTAP",
    joinError: "That code was not recognized. Check it and try again.",
    joinAdminHint: "School team: your school code. Owner: your admin code.",
    adminTitle: "Owner Admin",
    adminHelp: "Every school on RiderTap — status at a glance. Read-only.",
    adminSchools: "Schools",
    adminJoinCode: "Join code",
    adminDismissalsRun: "dismissals run",
    adminAvgDismissal: "Avg dismissal",
    adminLastActive: "Last dismissal",
    adminNever: "Never",
    adminToday: "On the board now",
    adminActiveHolds: "holds active",
    adminTotalCars: "Total cars moved",
    adminExit: "EXIT ADMIN",
    adminSpotsPerWave: "spots per wave",
    offline: "OFFLINE",
    numbersQueued: "numbers queued",
    connectionLost: "CONNECTION LOST",
    lastBoard: "Showing last confirmed board",
    backOnline: "Back online",
    numbersSynced: "numbers synced",
    simulateOffline: "Simulate offline",
    queuedTag: "QUEUED",
    willSync: "Sends itself when connection returns",
    queuedVerb: "queued",
    syncDup: "already called — not added twice",
    status: {
      entered: "Entered",
      on_board: "On Board",
      at_spot: "At Spot",
      loaded: "Loaded",
      departed: "Departed",
      no_show: "No Show",
    } as Record<string, string>,
  },
  es: {
    walker: "Ingresar Números",
    board: "Tablero",
    loader: "Cargar Autos",
    office: "Oficina",
    setup: "Configurar",
    help: "Ayuda",
    helpButton: "AYUDA — Cómo Funciona",
    tagline: "Toca el número. Mueve la fila.",
    leftLine: "FILA IZQUIERDA",
    rightLine: "FILA DERECHA",
    addCar: "AGREGAR AUTO",
    undo: "DESHACER",
    clear: "Borrar",
    alreadyCalled: "YA FUE LLAMADO",
    holdAlert: "EN ESPERA — NO ENTREGAR — VER OFICINA",
    added: "agregado",
    wave: "Grupo",
    spot: "Lugar",
    noCarsYet: "Aún no hay autos hoy. Los números que ingrese aparecen aquí y en el Tablero.",
    recent: "Recién ingresados",
    onBoard: "En Tablero",
    atSpot: "En el Lugar",
    markLoaded: "Cargado ✓",
    noShow: "No se presentó",
    releaseWave: "LIBERAR GRUPO",
    ready: "listos",
    waitingCars: "Aún Esperando",
    waitingHelp: "Cada número ingresado pero no cargado ni salido. Revise esta lista antes de terminar.",
    nobodyWaiting: "Nadie esperando — todos los autos cargaron o salieron.",
    holds: "Esperas (Hold)",
    holdsHelp: "Una espera no necesita motivo. No se guarda nada sobre el porqué. Los autos en espera no se pueden cargar.",
    holdNumberPlaceholder: "Número de etiqueta",
    setHold: "PONER ESPERA",
    clearHold: "QUITAR",
    endDismissal: "TERMINAR SALIDA",
    endConfirm: "Toque de nuevo para terminar y borrar los números de hoy",
    daySummary: "Resumen de hoy",
    carsLoaded: "Autos cargados",
    wavesRun: "Grupos",
    noShows: "No presentados",
    firstCar: "Primer auto",
    lastCar: "Último auto",
    numbersCleared: "Los números de hoy se borraron. Solo queda este resumen.",
    proofReport: "Informe de Prueba del Director",
    proofLatest: "Última salida",
    proofSemester: "Este semestre",
    proofHistory: "Historial",
    proofEmpty: "Aún no hay salidas completadas — su primer informe aparece después de Terminar Salida",
    avgDismissal: "Salida promedio",
    fastestDay: "Día más rápido",
    totalCarsMoved: "Total de autos",
    daysRecorded: "Días registrados",
    holdsPlacedLabel: "Esperas puestas",
    stillWaitingLabel: "aún esperando",
    dismissalComplete: "Salida completada",
    inWord: "en",
    carWord: "auto",
    carsWord: "autos",
    waveWord: "grupo",
    wavesWord: "grupos",
    noShowWord: "no presentados",
    under1Min: "menos de 1 min",
    trendIs: "La salida es",
    minWord: "min",
    trendFaster: "más rápida que su primera semana",
    trendSlower: "más lenta que su primera semana",
    trendSame: "La salida es casi igual que su primera semana",
    setupTitle: "Configuración de la escuela",
    schoolName: "Nombre de la escuela",
    district: "Distrito",
    county: "Condado",
    state: "Estado",
    schoolType: "Tipo de escuela",
    elementary: "Primaria",
    middle: "Secundaria",
    high: "Preparatoria",
    elementaryShort: "ES",
    middleShort: "MS",
    highShort: "HS",
    elementaryFull: "Escuela Primaria",
    middleFull: "Escuela Secundaria",
    highFull: "Escuela Preparatoria",
    selectedType: "Seleccionado",
    start: "Inicio de salida",
    end: "Fin de salida",
    spots: "Lugares por grupo",
    laneConfig: "¿Cómo funciona su fila?",
    singleFile: "Una fila",
    twoLines: "Dos filas — Izquierda / Derecha",
    leftLabel: "Nombre de la fila izquierda",
    rightLabel: "Nombre de la fila derecha",
    save: "GUARDAR",
    saved: "Guardado ✓",
    resetDemo: "Cambiar código de escuela",
    loadDemo: "Cargar la escuela demo",
    noSchool: "Aún no hay escuela configurada.",
    joinTitle: "Ingrese el código de su escuela",
    joinHelp:
      "Un solo código para todo su equipo de salida. Ingréselo una vez en cada teléfono del personal.",
    joinPlaceholder: "CÓDIGO",
    joinButton: "ABRIR RIDERTAP",
    joinError: "Ese código no fue reconocido. Verifíquelo e inténtelo de nuevo.",
    joinAdminHint: "Equipo escolar: su código de escuela. Dueño: su código de admin.",
    adminTitle: "Administración del Dueño",
    adminHelp: "Todas las escuelas en RiderTap — estado de un vistazo. Solo lectura.",
    adminSchools: "Escuelas",
    adminJoinCode: "Código",
    adminDismissalsRun: "salidas realizadas",
    adminAvgDismissal: "Salida promedio",
    adminLastActive: "Última salida",
    adminNever: "Nunca",
    adminToday: "En el tablero ahora",
    adminActiveHolds: "esperas activas",
    adminTotalCars: "Total de autos movidos",
    adminExit: "SALIR DE ADMIN",
    adminSpotsPerWave: "lugares por grupo",
    offline: "SIN CONEXIÓN",
    numbersQueued: "números en espera",
    connectionLost: "CONEXIÓN PERDIDA",
    lastBoard: "Mostrando el último tablero confirmado",
    backOnline: "Conexión restablecida",
    numbersSynced: "números sincronizados",
    simulateOffline: "Simular sin conexión",
    queuedTag: "EN ESPERA",
    willSync: "Se envía solo al volver la conexión",
    queuedVerb: "en espera",
    syncDup: "ya fue llamado — no se agregó dos veces",
    status: {
      entered: "Ingresado",
      on_board: "En Tablero",
      at_spot: "En el Lugar",
      loaded: "Cargado",
      departed: "Salió",
      no_show: "No se presentó",
    } as Record<string, string>,
  },
};

type HelpSectionData = {
  id: string;
  title: string;
  purpose: string;
  steps: string[];
  tip: string;
};

type HelpContent = {
  title: string;
  intro: string;
  quickTitle: string;
  quickPurpose: string;
  quickSteps: string[];
  quickTip: string;
  rememberLabel: string;
  jumpLabel: string;
  openLabel: string;
  sections: HelpSectionData[];
};

const HELP: Record<Lang, HelpContent> = {
  en: {
    title: "How It Works",
    intro: "Short answers, in plain words. Tap a topic to jump to it.",
    quickTitle: "Running Your First Dismissal",
    quickPurpose: "The whole dismissal, start to finish, in six steps.",
    quickSteps: [
      "Setup: enter your school once and pick Single File or Two Lines.",
      "Line Walker: tap your lane — LEFT or RIGHT — once.",
      "Walk the line and tap in each car's tag number, then ADD CAR.",
      "Holder Board: watch the numbers pop up and get those kids ready on the correct side.",
      "Loader: move each car Entered → On Board → At Spot → Loaded, then RELEASE WAVE when the count matches.",
      "Office: check Still Waiting is empty, then tap END DISMISSAL.",
    ],
    quickTip: "Numbers only — RiderTap never holds a child's name. The school keeps the number-to-child list, like it does today.",
    rememberLabel: "Remember",
    jumpLabel: "Jump to",
    openLabel: "Open",
    sections: [
      {
        id: "setup",
        title: "Setup",
        purpose: "Set up your school one time. You rarely come back here.",
        steps: [
          "Type the school name, district, county, and state.",
          "Tap ES, MS, or HS for your school type.",
          "Set dismissal start and end times and the loading spots per wave.",
          "Pick Single File or Two Lines — Left / Right. Name the lanes if your school calls them something else.",
          "Tap SAVE SETUP. Done — it stays saved.",
        ],
        tip: "Changing lanes or spots is fine anytime — it only affects new waves.",
      },
      {
        id: "walker",
        title: "Line Walker — Enter Numbers",
        purpose: "For the teacher walking the car line, tapping in tag numbers.",
        steps: [
          "If you have two lines, tap LEFT LINE or RIGHT LINE first. It stays put.",
          "Read the car's tag number and tap it on the big number pad.",
          "Tap the big green ADD CAR button. The number goes to the Board at once.",
          "Wrong number? Tap UNDO LAST — one tap fixes it.",
          "If a number was already entered, you will see ALREADY CALLED. Do not add it again.",
        ],
        tip: "Keep walking and tapping in order — the order you enter is the order kids are called.",
      },
      {
        id: "board",
        title: "Holder Board",
        purpose: "For the teacher with the kids. Numbers pop up live, in order.",
        steps: [
          "Watch your lane's column — LEFT on the left, RIGHT on the right, each its own color.",
          "When a number pops up, find that child using your school's own list or tags.",
          "Get those kids ready on the correct side before the cars reach the spots.",
          "A red number with HOLD means: do not release that child. See the office.",
          "When a number turns green, that car is loaded.",
        ],
        tip: "The board never goes blank — if the connection drops, it shows the last confirmed board.",
      },
      {
        id: "loader",
        title: "Loader — Load Cars",
        purpose: "For the teacher at the loading spots. One tap per step, per car.",
        steps: [
          "Pick your lane at the top if you have two lines.",
          "As each car moves, tap its button: Entered → On Board → At Spot → Loaded.",
          "If a car never shows up, tap No Show on that car.",
          "The wave can only be released when every car in it is Loaded or No Show — the count must match.",
          "Tap RELEASE WAVE. The wave leaves and the next wave moves up.",
        ],
        tip: "A held car cannot be loaded — its button is gone on purpose. See Holds below.",
      },
      {
        id: "office",
        title: "Office — Still Waiting, Holds & Ending",
        purpose: "For the office or lead teacher. The safety check at the end of the day.",
        steps: [
          "Still Waiting shows every number entered but not loaded. Check this list before ending.",
          "To hold a number, type it and tap SET HOLD. No reason is needed, and no reason is stored.",
          "Tap CLEAR on a hold when the office says the car may go.",
          "When Still Waiting is empty, tap END DISMISSAL, then tap again to confirm.",
          "Ending clears all of today's numbers. Only the day's totals are kept.",
        ],
        tip: "Never end dismissal while a number is still waiting — find that child first.",
      },
      {
        id: "offline",
        title: "Offline Mode",
        purpose: "Dismissal keeps running when the signal dies — rain or shine.",
        steps: [
          "Keep tapping in numbers exactly the same way. Nothing changes for you.",
          "The amber banner shows OFFLINE and how many numbers are queued on your phone.",
          "Queued numbers are tagged QUEUED and stay in the order you entered them.",
          "When the signal comes back, the queue sends itself — you tap nothing.",
          "You will see a green “Back online” message with how many numbers synced.",
        ],
        tip: "The “Simulate offline” button on Enter Numbers and Setup lets you practice this before a rainy day.",
      },
      {
        id: "holds",
        title: "Holds",
        purpose: "A hold stops a car from being released. No reason is ever stored.",
        steps: [
          "Anyone can set a hold: on the Board, tap HOLD next to the number — or set it in the Office.",
          "Every screen turns that number red: DO NOT RELEASE — SEE OFFICE.",
          "The Loader cannot load a held car until the hold is cleared.",
          "Only clear a hold when the office says so — tap CLEAR on the Board or in the Office.",
          "Holds set while offline queue on your phone and apply when the signal returns.",
        ],
        tip: "If you are ever unsure about a hold, keep the child with you and check with the office.",
      },
    ],
  },
  es: {
    title: "Cómo Funciona",
    intro: "Respuestas cortas, en palabras simples. Toque un tema para ir a él.",
    quickTitle: "Su Primera Salida, Paso a Paso",
    quickPurpose: "Toda la salida, de principio a fin, en seis pasos.",
    quickSteps: [
      "Configurar: ingrese su escuela una vez y elija Una fila o Dos filas.",
      "Ingresar Números: toque su fila — IZQUIERDA o DERECHA — una vez.",
      "Camine la fila y toque el número de cada auto, luego AGREGAR AUTO.",
      "Tablero: vea los números aparecer y prepare a esos niños en el lado correcto.",
      "Cargar Autos: mueva cada auto Ingresado → En Tablero → En el Lugar → Cargado, luego LIBERAR GRUPO cuando el conteo coincida.",
      "Oficina: revise que Aún Esperando esté vacío, luego toque TERMINAR SALIDA.",
    ],
    quickTip: "Solo números — RiderTap nunca guarda el nombre de un niño. La escuela mantiene su propia lista, como hoy.",
    rememberLabel: "Recuerde",
    jumpLabel: "Ir a",
    openLabel: "Abrir",
    sections: [
      {
        id: "setup",
        title: "Configurar",
        purpose: "Configure su escuela una sola vez. Casi nunca volverá aquí.",
        steps: [
          "Escriba el nombre de la escuela, el distrito, el condado y el estado.",
          "Toque ES, MS o HS según el tipo de escuela.",
          "Ajuste la hora de inicio y fin de la salida y los lugares por grupo.",
          "Elija Una fila o Dos filas — Izquierda / Derecha. Cambie los nombres si su escuela los llama diferente.",
          "Toque GUARDAR. Listo — queda guardado.",
        ],
        tip: "Puede cambiar filas o lugares cuando quiera — solo afecta a los grupos nuevos.",
      },
      {
        id: "walker",
        title: "Ingresar Números",
        purpose: "Para la maestra que camina la fila de autos e ingresa los números.",
        steps: [
          "Si tiene dos filas, toque primero FILA IZQUIERDA o FILA DERECHA. Queda fijo.",
          "Lea el número del auto y tóquelo en el teclado grande.",
          "Toque el botón verde grande AGREGAR AUTO. El número llega al Tablero al instante.",
          "¿Número equivocado? Toque DESHACER — un toque lo corrige.",
          "Si un número ya fue ingresado, verá YA FUE LLAMADO. No lo agregue otra vez.",
        ],
        tip: "Siga caminando e ingresando en orden — el orden en que ingresa es el orden en que se llama a los niños.",
      },
      {
        id: "board",
        title: "Tablero",
        purpose: "Para la maestra con los niños. Los números aparecen en vivo, en orden.",
        steps: [
          "Mire la columna de su fila — IZQUIERDA a la izquierda, DERECHA a la derecha, cada una con su color.",
          "Cuando aparezca un número, busque a ese niño con la lista o etiquetas de su escuela.",
          "Prepare a esos niños en el lado correcto antes de que los autos lleguen a los lugares.",
          "Un número rojo con ESPERA significa: no entregue a ese niño. Vea a la oficina.",
          "Cuando un número se pone verde, ese auto ya cargó.",
        ],
        tip: "El tablero nunca se queda en blanco — si se pierde la conexión, muestra el último tablero confirmado.",
      },
      {
        id: "loader",
        title: "Cargar Autos",
        purpose: "Para la maestra en los lugares de carga. Un toque por paso, por auto.",
        steps: [
          "Elija su fila arriba si tiene dos filas.",
          "A medida que cada auto avanza, toque su botón: Ingresado → En Tablero → En el Lugar → Cargado.",
          "Si un auto nunca llega, toque No se presentó en ese auto.",
          "El grupo solo se libera cuando cada auto está Cargado o No se presentó — el conteo debe coincidir.",
          "Toque LIBERAR GRUPO. El grupo sale y el siguiente grupo avanza.",
        ],
        tip: "Un auto en espera no se puede cargar — su botón desaparece a propósito. Vea Esperas abajo.",
      },
      {
        id: "office",
        title: "Oficina — Aún Esperando, Esperas y Cierre",
        purpose: "Para la oficina o la maestra encargada. La revisión de seguridad al final del día.",
        steps: [
          "Aún Esperando muestra cada número ingresado pero no cargado. Revise esta lista antes de terminar.",
          "Para poner una espera, escriba el número y toque PONER ESPERA. No se necesita motivo, y ningún motivo se guarda.",
          "Toque QUITAR en una espera cuando la oficina diga que el auto puede irse.",
          "Cuando Aún Esperando esté vacío, toque TERMINAR SALIDA y toque de nuevo para confirmar.",
          "Al terminar se borran todos los números de hoy. Solo quedan los totales del día.",
        ],
        tip: "Nunca termine la salida mientras un número siga esperando — busque primero a ese niño.",
      },
      {
        id: "offline",
        title: "Modo Sin Conexión",
        purpose: "La salida sigue funcionando cuando se va la señal — con lluvia o sol.",
        steps: [
          "Siga ingresando números exactamente igual. Nada cambia para usted.",
          "El aviso ámbar muestra SIN CONEXIÓN y cuántos números están en espera en su teléfono.",
          "Los números en espera llevan la etiqueta EN ESPERA y quedan en el orden en que los ingresó.",
          "Cuando vuelva la señal, la lista se envía sola — usted no toca nada.",
          "Verá un mensaje verde de conexión restablecida con cuántos números se sincronizaron.",
        ],
        tip: "El botón “Simular sin conexión” en Ingresar Números y Configurar le permite practicar antes de un día de lluvia.",
      },
      {
        id: "holds",
        title: "Esperas (Hold)",
        purpose: "Una espera impide que un auto salga. Nunca se guarda un motivo.",
        steps: [
          "Cualquiera puede poner una espera: en el Tablero, toque HOLD junto al número — o póngala en la Oficina.",
          "Todas las pantallas ponen ese número en rojo: NO ENTREGAR — VER OFICINA.",
          "El cargador no puede cargar un auto en espera hasta que se quite la espera.",
          "Quite una espera solo cuando la oficina lo diga — toque QUITAR en el Tablero o en la Oficina.",
          "Las esperas puestas sin conexión quedan en su teléfono y se aplican cuando vuelve la señal.",
        ],
        tip: "Si alguna vez duda sobre una espera, quédese con el niño y consulte con la oficina.",
      },
    ],
  },
};

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

type DaySummary = State["summaries"][number];

// Human duration: "under 1 min" · "23 min" · "1 h 4 min".
function fmtDurationMs(ms: number, t: TDict): string {
  if (ms < 60000) return t.under1Min;
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h} h ${m} min`;
}

// Null when the summary predates startedAt tracking — renders as "—" and
// is excluded from every duration average.
function summaryDurationMs(s: DaySummary): number | null {
  if (!s.startedAt || !s.endedAt) return null;
  const d = new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime();
  return Number.isFinite(d) && d >= 0 ? d : null;
}

function laneLabel(school: School, lane: string): string {
  if (lane === "left") return school.leftLabel;
  if (lane === "right") return school.rightLabel;
  return school.laneMode === "single" ? "Line" : lane;
}

function lanesOf(school: School): string[] {
  return school.laneMode === "single" ? ["main"] : ["left", "right"];
}

type QueuedItem = {
  id: string;
  kind: "entry" | "hold" | "clearHold";
  number: string;
  lane: string;
  ts: number;
};

type OfflineApi = {
  offline: boolean;
  simulated: boolean;
  setSimulated: (v: boolean) => void;
  outbox: QueuedItem[];
  enqueue: (item: { kind: QueuedItem["kind"]; number: string; lane: string }) => void;
  removeById: (id: string) => void;
  effectiveHolds: Set<string>;
};

export function App() {
  const [view, setView] = useState<View>("walker");
  const [lang, setLang] = useState<Lang>("en");
  const t = T[lang];
  const queryClient = useQueryClient();

  // ---- Offline outbox: an on-device queue that survives reloads. ----
  const [simulatedOffline, setSimulatedOffline] = useState<boolean>(() => {
    try {
      return localStorage.getItem("ridertap-sim-offline") === "1";
    } catch {
      return false;
    }
  });
  const [realOnline, setRealOnline] = useState<boolean>(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const offline = simulatedOffline || !realOnline;
  const [outbox, setOutbox] = useState<QueuedItem[]>(() => {
    try {
      const raw = localStorage.getItem("ridertap-outbox-v1");
      return raw ? (JSON.parse(raw) as QueuedItem[]) : [];
    } catch {
      return [];
    }
  });
  const [syncMsg, setSyncMsg] = useState<{ synced: number; dups: string[] } | null>(
    null,
  );
  const syncingRef = useRef(false);

  useEffect(() => {
    const on = () => setRealOnline(true);
    const offFn = () => setRealOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", offFn);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", offFn);
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("ridertap-sim-offline", simulatedOffline ? "1" : "0");
    } catch {
      // storage unavailable — the toggle still works for this session
    }
  }, [simulatedOffline]);

  useEffect(() => {
    try {
      localStorage.setItem("ridertap-outbox-v1", JSON.stringify(outbox));
    } catch {
      // storage unavailable — the queue still works for this session
    }
  }, [outbox]);

  // Production: the school join code is this device's tenant key. No code
  // → the join screen renders instead of the app (see the early return
  // below). The artifact's seedDemo auto-seed has no production equivalent:
  // schools are provisioned, never self-created from the client.
  const [schoolCode, setSchoolCodeState] = useState<string | null>(() =>
    getSchoolCode(),
  );
  const [codeDraft, setCodeDraft] = useState("");
  // Owner Admin Board: a separate stored code (own localStorage key).
  // When it verifies, the Admin view replaces everything else on this
  // device until JR exits admin.
  const [adminCode, setAdminCodeState] = useState<string | null>(() =>
    getAdminCode(),
  );
  const [gateBusy, setGateBusy] = useState(false);
  // Set when the server rejects a code (401/403): the gate then renders
  // STATICALLY with the error — see the rejection effect below.
  const [gateRejected, setGateRejected] = useState(false);

  const state = useQuery({
    queryKey: ["state"],
    queryFn: () => api.getState({}),
    refetchInterval: offline ? false : 3000,
    enabled: schoolCode !== null,
    // No retry storm: the 3 s poll is the retry while a code is stored,
    // and a rejected code clears itself (effect below) which disables
    // this query outright.
    retry: false,
  });

  const admin = useQuery({
    queryKey: ["adminOverview"],
    queryFn: () => api.adminOverview({}),
    enabled: adminCode !== null,
    retry: false,
  });

  // A stored ADMIN code that no longer verifies (rotated, or ADMIN_CODE
  // not yet set server-side) is forgotten quietly — the gate just shows.
  useEffect(() => {
    if (admin.isError && adminCode) {
      clearAdminCode();
      setAdminCodeState(null);
    }
  }, [admin.isError, adminCode]);

  // REJECTED SCHOOL CODE — the flicker fix. Previously a bad stored code
  // stayed in localStorage while the state query kept failing on its
  // poll/retry cycle, and the gate's render condition flipped between
  // the gate and the loading shell on every flip of state.isError —
  // remounting the code input and wiping its focus mid-typing. Now: on a
  // 401/403 the stored code is CLEARED (which disables the query — no
  // interval, no retries), and the gate renders statically with the
  // error while the draft text stays untouched in App state.
  useEffect(() => {
    if (!state.isError || !schoolCode) return;
    const msg = state.error instanceof Error ? state.error.message : "";
    if (msg.includes("401") || msg.includes("403")) {
      clearSchoolCode();
      setSchoolCodeState(null);
      setGateRejected(true);
    }
  }, [state.isError, state.error, schoolCode]);

  const data = state.data;
  const school = data?.school ?? null;

  // Holds as this device knows them: server holds with queued offline
  // hold/clear operations applied in order. A hold synced before a
  // connection drop therefore still warns on this device while offline.
  const effectiveHolds = new Set<string>(data?.holds ?? []);
  for (const item of outbox) {
    if (item.kind === "hold") effectiveHolds.add(item.number);
    if (item.kind === "clearHold") effectiveHolds.delete(item.number);
  }
  const queuedEntryCount = outbox.filter((i) => i.kind === "entry").length;

  const enqueue = (item: { kind: QueuedItem["kind"]; number: string; lane: string }) => {
    setOutbox((prev) => [
      ...prev,
      {
        ...item,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: Date.now(),
      },
    ]);
  };

  const offApi: OfflineApi = {
    offline,
    simulated: simulatedOffline,
    setSimulated: setSimulatedOffline,
    outbox,
    enqueue,
    removeById: (id) => setOutbox((prev) => prev.filter((i) => i.id !== id)),
    effectiveHolds,
  };

  // Auto-sync: the moment connectivity returns, the outbox sends itself in
  // original entry order — no staff action. The server's duplicate guard
  // flags any number entered twice (offline/offline or offline/online).
  useEffect(() => {
    // Unauthenticated devices NEVER fire the outbox: with no verified
    // school code stored there is no tenant to sync against, and queued
    // items simply wait for a successful code entry.
    if (offline || outbox.length === 0 || syncingRef.current || schoolCode === null)
      return;
    syncingRef.current = true;
    const items = [...outbox];
    void (async () => {
      const processed = new Set<string>();
      let syncedEntries = 0;
      const dups: string[] = [];
      try {
        for (const item of items) {
          if (item.kind === "entry") {
            const res = await api.addEntry({ number: item.number, lane: item.lane });
            if (res.ok) syncedEntries++;
            else if (res.reason === "duplicate") dups.push(item.number);
          } else if (item.kind === "hold") {
            await api.setHold({ number: item.number });
          } else {
            await api.clearHold({ number: item.number });
          }
          processed.add(item.id);
        }
      } catch {
        // Connection dropped mid-sync: unprocessed items stay queued.
      }
      setOutbox((prev) => prev.filter((i) => !processed.has(i.id)));
      syncingRef.current = false;
      if (processed.size > 0) {
        queryClient.invalidateQueries({ queryKey: ["state"] });
        setSyncMsg({ synced: syncedEntries, dups });
      }
    })();
  }, [offline, outbox, queryClient, schoolCode]);

  useEffect(() => {
    if (!syncMsg) return;
    const tm = setTimeout(() => setSyncMsg(null), 8000);
    return () => clearTimeout(tm);
  }, [syncMsg]);
  const waitingCount =
    data?.entries.filter(
      (e) => e.status !== "loaded" && e.status !== "departed" && e.status !== "no_show",
    ).length ?? 0;

  const navBtn = (v: View, label: string, badge?: number) => (
    <button
      key={v}
      type="button"
      aria-label={label}
      aria-current={view === v ? "page" : undefined}
      onClick={() => setView(v)}
      className={`relative flex min-h-16 min-w-0 flex-1 basis-0 items-center justify-center px-0.5 py-2 ${
        view === v
          ? "bg-[var(--text)] text-[var(--bg)]"
          : "text-[var(--text)]"
      }`}
    >
      <span className="whitespace-nowrap text-[clamp(0.5rem,2vw,0.8125rem)] font-bold leading-none tracking-[-0.01em]">
        {label}
      </span>
      {badge != null && badge > 0 && (
        <span className="absolute right-1.5 top-1.5 flex h-6 min-w-6 items-center justify-center rounded-full bg-[var(--hold)] px-1 text-sm font-bold text-white">
          {badge}
        </span>
      )}
    </button>
  );

  const exitAdmin = () => {
    clearAdminCode();
    setAdminCodeState(null);
    clearSchoolCode();
    setSchoolCodeState(null);
    setCodeDraft("");
    queryClient.removeQueries({ queryKey: ["adminOverview"] });
  };

  const submitGateCode = async () => {
    const code = codeDraft.trim().toUpperCase();
    if (!code || gateBusy) return;
    setGateBusy(true);
    setGateRejected(false);
    // Owner code first: if it verifies against ADMIN_CODE, this device
    // opens the Admin Board. The code is stored under the ADMIN key only
    // — never as a school code — and the school flow below never runs.
    try {
      setAdminCode(code);
      const overview = await api.adminOverview({});
      queryClient.setQueryData(["adminOverview"], overview);
      setAdminCodeState(code);
      setCodeDraft("");
      setGateBusy(false);
      return;
    } catch {
      clearAdminCode();
      setAdminCodeState(null);
    }
    // School flow, exactly as before: store the code and let the state
    // query verify it. A 401/403 lands in the rejection effect above,
    // which clears the stored code and holds this gate static.
    setSchoolCode(code);
    setSchoolCodeState(code);
    queryClient.invalidateQueries({ queryKey: ["state"] });
    setGateBusy(false);
  };

  // Admin Board: a verified owner code takes over this device.
  if (adminCode && admin.data) {
    return (
      <AdminView
        data={admin.data}
        t={t}
        lang={lang}
        onToggleLang={() => setLang(lang === "en" ? "es" : "en")}
        onExit={exitAdmin}
      />
    );
  }
  if (adminCode && admin.isPending && !schoolCode) {
    return (
      <div className="min-h-screen bg-[var(--bg)] px-4 py-10 text-[var(--text)]">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <div className="mx-auto flex max-w-md flex-col items-center text-center">
          <RiderTapLogo size={76} />
          <p className="mt-8 text-xl font-semibold">…</p>
        </div>
      </div>
    );
  }

  // Join gate: no verified code on this device → one-time code entry,
  // nothing else renders. The condition is deliberately JUST the code's
  // absence: while a submitted code is being verified (or after it is
  // rejected and cleared) the gate stays mounted, so the input keeps
  // its contents and focus instead of flickering against a shell.
  if (!schoolCode) {
    return (
      <div className="min-h-screen bg-[var(--bg)] px-4 py-10 text-[var(--text)]">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <div className="mx-auto flex max-w-md flex-col items-center text-center">
          <RiderTapLogo size={76} />
          <p className="mt-4 font-display text-4xl font-bold uppercase leading-none tracking-wide">
            RiderTap
          </p>
          <p className="mt-2 text-base font-semibold text-[var(--dim)]">
            {t.tagline}
          </p>
          <p className="mt-8 text-2xl font-bold">{t.joinTitle}</p>
          <p className="mt-2 text-base font-medium text-[var(--dim)]">
            {t.joinHelp}
          </p>
          {gateRejected && (
            <p
              role="alert"
              className="mt-4 w-full rounded-2xl bg-[var(--hold)] px-4 py-3 text-lg font-bold text-white"
            >
              {t.joinError}
            </p>
          )}
          <input
            aria-label={t.joinTitle}
            value={codeDraft}
            onChange={(ev) => setCodeDraft(ev.target.value)}
            placeholder={t.joinPlaceholder}
            autoCapitalize="characters"
            autoCorrect="off"
            className="mt-6 min-h-16 w-full rounded-2xl border-2 border-[var(--border)] bg-[var(--surface)] px-4 text-center text-2xl font-bold uppercase tracking-widest"
          />
          <button
            type="button"
            disabled={codeDraft.trim().length === 0 || gateBusy}
            onClick={() => void submitGateCode()}
            className="mt-4 min-h-16 w-full rounded-2xl bg-[var(--go)] font-display text-2xl font-bold text-white disabled:opacity-50"
          >
            {t.joinButton}
          </button>
          <p className="mt-3 text-sm font-semibold text-[var(--dim)]">
            {t.joinAdminHint}
          </p>
          <button
            type="button"
            aria-label={
              lang === "en" ? "Cambiar a español" : "Switch to English"
            }
            onClick={() => setLang(lang === "en" ? "es" : "en")}
            className="mt-6 min-h-12 rounded-xl border-2 border-[var(--border)] bg-[var(--surface)] px-4 text-lg font-bold"
          >
            {lang === "en" ? "ES" : "EN"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <header className="px-4 pb-1 pt-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <RiderTapLogo size={52} />
            <div>
              <p className="font-display text-3xl font-bold uppercase leading-none tracking-wide">
                RiderTap
              </p>
              <p className="mt-1 text-sm font-semibold text-[var(--dim)]">
                {school ? school.name : t.tagline}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-start gap-2">
            <button
              type="button"
              aria-label={lang === "en" ? "Cambiar a español" : "Switch to English"}
              onClick={() => setLang(lang === "en" ? "es" : "en")}
              className="min-h-12 rounded-xl border-2 border-[var(--border)] bg-[var(--surface)] px-4 text-lg font-bold"
            >
              {lang === "en" ? "ES" : "EN"}
            </button>
          </div>
        </div>
        <button
          type="button"
          aria-label={t.helpButton}
          aria-current={view === "help" ? "page" : undefined}
          onClick={() => setView("help")}
          className={`mt-3 min-h-16 w-full rounded-2xl font-display text-2xl font-bold uppercase tracking-wide ${
            view === "help"
              ? "bg-[var(--text)] text-[var(--bg)]"
              : "bg-[var(--go)] text-white"
          }`}
        >
          ? {t.helpButton}
        </button>
      </header>

      <main className="px-3 pb-32 pt-2">
        {offline && school && (
          <div
            role="alert"
            className="mb-3 rounded-2xl bg-[var(--left)] px-4 py-4 text-center text-[#0b1d3a]"
          >
            <p className="font-display text-3xl font-bold uppercase leading-tight">
              {view === "walker"
                ? `📵 ${t.offline} — ${queuedEntryCount} ${t.numbersQueued}`
                : `📵 ${t.connectionLost}`}
            </p>
            <p className="mt-1 text-base font-bold">
              {view === "walker" ? t.willSync : t.lastBoard}
            </p>
          </div>
        )}
        {!offline && syncMsg && (
          <div
            role="status"
            className="mb-3 rounded-2xl bg-[var(--go)] px-4 py-3 text-center text-xl font-bold text-white"
          >
            ✓ {t.backOnline} — {syncMsg.synced} {t.numbersSynced}
            {syncMsg.dups.length > 0 &&
              ` · ${syncMsg.dups.join(", ")} ${t.syncDup}`}
          </div>
        )}
        {view === "help" ? (
          <HelpView lang={lang} t={t} onGo={(v) => setView(v)} />
        ) : state.isPending || !data ? (
          <p className="py-16 text-center text-xl font-semibold">…</p>
        ) : !school ? (
          <div className="py-10 text-center">
            <p className="text-xl font-bold">{t.noSchool}</p>
          </div>
        ) : view === "walker" ? (
          <WalkerView data={data} school={school} t={t} off={offApi} />
        ) : view === "board" ? (
          <BoardView data={data} school={school} t={t} off={offApi} />
        ) : view === "loader" ? (
          <LoaderView data={data} school={school} t={t} off={offApi} />
        ) : view === "office" ? (
          <OfficeView data={data} school={school} t={t} off={offApi} lang={lang} />
        ) : (
          <SetupView school={school} t={t} off={offApi} />
        )}
      </main>

      <nav
        aria-label="RiderTap screens"
        className="fixed inset-x-0 bottom-0 z-20 flex border-t-2 border-[var(--border)] bg-[var(--surface)] pb-safe"
      >
        {navBtn("walker", t.walker)}
        {navBtn("board", t.board)}
        {navBtn("loader", t.loader)}
        {navBtn("office", t.office, waitingCount)}
        {navBtn("setup", t.setup)}
      </nav>
    </div>
  );
}

type TDict = (typeof T)["en"];

function AdminView({
  data,
  t,
  lang,
  onToggleLang,
  onExit,
}: {
  data: AdminOverview;
  t: TDict;
  lang: Lang;
  onToggleLang: () => void;
  onExit: () => void;
}) {
  const locale = lang === "es" ? "es" : "en";
  const fmtDate = (d: string | null): string =>
    d
      ? new Date(`${d}T12:00:00`).toLocaleDateString(locale, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : t.adminNever;
  const fmtAvg = (sec: number | null): string =>
    sec == null ? "—" : fmtDurationMs(Math.round(sec * 1000), t);
  const typeFull = (s: AdminSchool): string =>
    s.schoolType === "middle"
      ? t.middleFull
      : s.schoolType === "high"
        ? t.highFull
        : t.elementaryFull;

  const tile = (value: string, label: string) => (
    <div className="rounded-xl bg-[var(--surface2)] p-3 text-center">
      <p className="font-display text-3xl font-bold leading-tight">{value}</p>
      <p className="text-xs font-bold uppercase">{label}</p>
    </div>
  );

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <header className="px-4 pb-1 pt-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <RiderTapLogo size={52} />
            <div>
              <p className="font-display text-3xl font-bold uppercase leading-none tracking-wide">
                RiderTap
              </p>
              <p className="mt-1 text-sm font-semibold text-[var(--dim)]">
                {t.adminTitle}
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label={lang === "en" ? "Cambiar a español" : "Switch to English"}
            onClick={onToggleLang}
            className="min-h-12 shrink-0 rounded-xl border-2 border-[var(--border)] bg-[var(--surface)] px-4 text-lg font-bold"
          >
            {lang === "en" ? "ES" : "EN"}
          </button>
        </div>
        <p className="mt-3 text-base font-medium text-[var(--dim)]">
          {t.adminHelp}
        </p>
      </header>

      <main className="mx-auto max-w-2xl space-y-3 px-3 pb-16 pt-3">
        <h2 className="text-lg font-bold uppercase tracking-wide text-[var(--dim)]">
          {t.adminSchools} ({data.schools.length})
        </h2>
        {data.schools.map((s) => (
          <section
            key={s.id}
            aria-label={s.name}
            className="rounded-2xl bg-[var(--surface)] p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="font-display text-3xl font-bold leading-tight">
                  {s.name}
                </h3>
                <p className="mt-0.5 text-base font-semibold text-[var(--dim)]">
                  {s.county}
                  {s.state ? `, ${s.state}` : ""}
                  {s.district ? ` · ${s.district}` : ""} · {typeFull(s)}
                </p>
              </div>
              <p className="rounded-lg bg-[var(--surface2)] px-3 py-2 text-right">
                <span className="block text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">
                  {t.adminJoinCode}
                </span>
                <span className="font-display text-xl font-bold tracking-wider">
                  {s.joinCode}
                </span>
              </p>
            </div>

            <p className="mt-3 text-lg font-bold leading-snug">
              {s.summary.daysRecorded} {t.adminDismissalsRun} ·{" "}
              {t.adminAvgDismissal} {fmtAvg(s.summary.avgDismissalDurationSec)}{" "}
              · {t.adminLastActive} {fmtDate(s.summary.lastDismissalDate)}
            </p>

            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {tile(String(s.today.activeEntries), t.adminToday)}
              {tile(String(s.today.activeHolds), t.adminActiveHolds)}
              {tile(String(s.summary.totalCarsLoaded), t.adminTotalCars)}
              {tile(String(s.spotsPerWave), t.adminSpotsPerWave)}
            </div>

            <p className="mt-3 text-base font-medium text-[var(--dim)]">
              {s.laneMode === "single"
                ? t.singleFile
                : `${s.leftLabel} / ${s.rightLabel}`}{" "}
              · {t.status.entered} {s.today.byStatus.entered} · {t.onBoard}{" "}
              {s.today.byStatus.on_board} · {t.atSpot}{" "}
              {s.today.byStatus.at_spot} · {t.status.loaded}{" "}
              {s.today.byStatus.loaded}
            </p>
          </section>
        ))}

        <button
          type="button"
          aria-label={t.adminExit}
          onClick={onExit}
          className="min-h-16 w-full rounded-2xl border-2 border-[var(--border)] bg-[var(--surface)] font-display text-2xl font-bold"
        >
          {t.adminExit}
        </button>
      </main>
    </div>
  );
}

function OfflineToggle({
  off,
  t,
  big,
}: {
  off: OfflineApi;
  t: TDict;
  big?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={t.simulateOffline}
      aria-pressed={off.simulated}
      onClick={() => off.setSimulated(!off.simulated)}
      className={`rounded-xl border-2 font-bold ${
        big ? "min-h-16 w-full text-2xl" : "min-h-12 px-4 text-base"
      } ${
        off.simulated
          ? "border-[var(--hold)] bg-[var(--hold)] text-white"
          : "border-[var(--border)] bg-[var(--surface)]"
      }`}
    >
      📵 {t.simulateOffline}: {off.simulated ? "ON" : "OFF"}
    </button>
  );
}

function HoldBanner({ t }: { t: TDict }) {
  return (
    <div
      role="alert"
      className="rounded-2xl bg-[var(--hold)] px-4 py-3 text-center text-xl font-bold uppercase text-white"
    >
      ⛔ {t.holdAlert}
    </div>
  );
}

function WalkerView({
  data,
  school,
  t,
  off,
}: {
  data: State;
  school: School;
  t: TDict;
  off: OfflineApi;
}) {
  const queryClient = useQueryClient();
  const dual = school.laneMode === "dual";
  const [lane, setLane] = useState<string>(dual ? "left" : "main");
  const [buffer, setBuffer] = useState("");
  const [notice, setNotice] = useState<
    | { kind: "added"; text: string }
    | { kind: "dup"; text: string }
    | { kind: "hold" }
    | null
  >(null);

  useEffect(() => {
    if (!dual) setLane("main");
  }, [dual]);

  const addMut = useMutation({
    mutationFn: (num: string) => api.addEntry({ number: num, lane }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      if (res.ok && res.entry) {
        setBuffer("");
        if (res.holdWarning) {
          setNotice({ kind: "hold" });
        } else {
          setNotice({
            kind: "added",
            text: `${res.entry.number} ${t.added} — ${laneLabel(school, res.entry.lane)} · ${t.wave} ${res.entry.waveNumber} · ${t.spot} ${res.entry.spot}`,
          });
        }
      } else if (res.reason === "duplicate" && res.existing) {
        setNotice({
          kind: "dup",
          text: `${buffer} — ${t.alreadyCalled} · ${laneLabel(school, res.existing.lane)} · ${t.wave} ${res.existing.waveNumber} · ${t.spot} ${res.existing.spot}`,
        });
        setBuffer("");
      }
    },
  });

  const undoMut = useMutation({
    mutationFn: () => api.undoLastEntry({}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      setNotice(null);
    },
  });

  const press = (d: string) => {
    setNotice(null);
    setBuffer((b) => (b.length >= 6 ? b : b + d));
  };

  // Offline: entry works exactly the same, but the number goes into the
  // on-device outbox instead of the server. Duplicates are caught locally
  // against both the last confirmed board and the queue itself, and a
  // locally-known hold still warns before queueing.
  const handleAdd = () => {
    const num = buffer;
    if (!num) return;
    if (!off.offline) {
      addMut.mutate(num);
      return;
    }
    const serverDup = data.entries.find(
      (e) =>
        e.number === num && e.status !== "departed" && e.status !== "no_show",
    );
    const queuedDup = off.outbox.find(
      (i) => i.kind === "entry" && i.number === num,
    );
    if (serverDup) {
      setNotice({
        kind: "dup",
        text: `${num} — ${t.alreadyCalled} · ${laneLabel(school, serverDup.lane)} · ${t.wave} ${serverDup.waveNumber} · ${t.spot} ${serverDup.spot}`,
      });
    } else if (queuedDup) {
      setNotice({
        kind: "dup",
        text: `${num} — ${t.alreadyCalled} · ${laneLabel(school, queuedDup.lane)} · ${t.queuedTag}`,
      });
    } else if (off.effectiveHolds.has(num)) {
      off.enqueue({ kind: "entry", number: num, lane });
      setNotice({ kind: "hold" });
    } else {
      off.enqueue({ kind: "entry", number: num, lane });
      setNotice({
        kind: "added",
        text: `${num} ${t.queuedVerb} — ${laneLabel(school, lane)} · ${t.willSync}`,
      });
    }
    setBuffer("");
  };

  const handleUndo = () => {
    if (off.offline) {
      const queuedEntries = off.outbox.filter((i) => i.kind === "entry");
      const last = queuedEntries[queuedEntries.length - 1];
      if (last) {
        off.removeById(last.id);
        setNotice(null);
      }
      return;
    }
    undoMut.mutate();
  };

  const queuedRecent = off.outbox.filter((i) => i.kind === "entry").reverse();

  const recent = [...data.entries]
    .filter((e) => e.status !== "departed" && e.status !== "no_show")
    .slice(-6)
    .reverse();

  const padBtn =
    "flex min-h-[76px] items-center justify-center rounded-2xl bg-[var(--surface)] font-display text-4xl font-semibold shadow-sm border-2 border-[var(--border)] active:bg-[var(--surface2)]";

  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-3 flex justify-end">
        <OfflineToggle off={off} t={t} />
      </div>
      {dual && (
        <div className="mb-3 grid grid-cols-2 gap-2" role="group" aria-label="Lane">
          <button
            type="button"
            aria-label={t.leftLine}
            aria-pressed={lane === "left"}
            onClick={() => setLane("left")}
            className={`flex min-h-20 items-center justify-center gap-1.5 whitespace-nowrap rounded-2xl px-2 font-display font-bold leading-none sm:gap-2 ${
              lane === "left"
                ? "bg-[var(--left)] text-[#0b1d3a]"
                : "border-2 border-[var(--left)] bg-[var(--surface)] text-[var(--left-dark)]"
            }`}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              fill="currentColor"
              className="h-5 w-5 shrink-0 sm:h-7 sm:w-7"
            >
              <path d="M11.5 1.5 4.5 8l7 6.5z" />
            </svg>
            <span className="whitespace-nowrap text-[clamp(1rem,5vw,1.875rem)] leading-none">
              {t.leftLine}
            </span>
          </button>
          <button
            type="button"
            aria-label={t.rightLine}
            aria-pressed={lane === "right"}
            onClick={() => setLane("right")}
            className={`flex min-h-20 items-center justify-center gap-1.5 whitespace-nowrap rounded-2xl px-2 font-display font-bold leading-none sm:gap-2 ${
              lane === "right"
                ? "bg-[var(--right)] text-white"
                : "border-2 border-[var(--right)] bg-[var(--surface)] text-[var(--right)]"
            }`}
          >
            <span className="whitespace-nowrap text-[clamp(1rem,5vw,1.875rem)] leading-none">
              {t.rightLine}
            </span>
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              fill="currentColor"
              className="h-5 w-5 shrink-0 sm:h-7 sm:w-7"
            >
              <path d="M4.5 1.5 11.5 8l-7 6.5z" />
            </svg>
          </button>
        </div>
      )}

      <div
        aria-live="polite"
        className="mb-3 flex min-h-24 items-center justify-center rounded-2xl bg-[var(--text)] px-4"
      >
        <span className="font-display text-7xl font-bold tracking-[0.2em] text-[var(--bg)]">
          {buffer || "----"}
        </span>
      </div>

      {notice?.kind === "hold" && (
        <div className="mb-3">
          <HoldBanner t={t} />
        </div>
      )}
      {notice?.kind === "dup" && (
        <div
          role="alert"
          className="mb-3 rounded-2xl bg-[var(--left)] px-4 py-3 text-center text-xl font-bold text-[#0b1d3a]"
        >
          ⚠ {notice.text}
        </div>
      )}
      {notice?.kind === "added" && (
        <div className="mb-3 rounded-2xl bg-[var(--go)] px-4 py-3 text-center text-xl font-bold text-white">
          ✓ {notice.text}
        </div>
      )}

      <div className="grid grid-cols-3 gap-2">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <button
            key={d}
            type="button"
            aria-label={`Digit ${d}`}
            className={padBtn}
            onClick={() => press(d)}
          >
            {d}
          </button>
        ))}
        <button
          type="button"
          aria-label={t.clear}
          className="flex min-h-[76px] items-center justify-center rounded-2xl border-2 border-[var(--border)] bg-[var(--surface2)] text-xl font-bold"
          onClick={() => setBuffer("")}
        >
          C
        </button>
        <button
          type="button"
          aria-label="Digit 0"
          className={padBtn}
          onClick={() => press("0")}
        >
          0
        </button>
        <button
          type="button"
          aria-label="Backspace"
          className="flex min-h-[76px] items-center justify-center rounded-2xl border-2 border-[var(--border)] bg-[var(--surface2)] font-display text-4xl font-semibold"
          onClick={() => setBuffer((b) => b.slice(0, -1))}
        >
          ⌫
        </button>
      </div>

      <button
        type="button"
        aria-label={t.addCar}
        disabled={buffer.length === 0 || (!off.offline && addMut.isPending)}
        onClick={handleAdd}
        className="mt-3 min-h-20 w-full rounded-2xl bg-[var(--go)] font-display text-4xl font-bold text-white disabled:opacity-40"
      >
        {t.addCar} {buffer ? `· ${buffer}` : ""}
      </button>
      <button
        type="button"
        aria-label={t.undo}
        disabled={!off.offline && undoMut.isPending}
        onClick={handleUndo}
        className="mt-2 min-h-14 w-full rounded-2xl border-2 border-[var(--border)] bg-[var(--surface)] text-xl font-bold"
      >
        ↩ {t.undo}
      </button>

      <h2 className="mb-2 mt-6 text-lg font-bold uppercase tracking-wide text-[var(--dim)]">
        {t.recent}
      </h2>
      {queuedRecent.length > 0 && (
        <ul className="mb-2 space-y-2">
          {queuedRecent.map((q) => (
            <li
              key={q.id}
              className="flex items-center justify-between rounded-xl border-4 border-dashed border-[var(--left-dark)] bg-[var(--surface)] px-4 py-2"
            >
              <span className="font-display text-4xl font-bold">{q.number}</span>
              <span className="text-base font-bold uppercase">
                📵 {t.queuedTag} · {laneLabel(school, q.lane)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {recent.length === 0 && queuedRecent.length === 0 ? (
        <p className="text-lg text-[var(--dim)]">{t.noCarsYet}</p>
      ) : recent.length === 0 ? null : (
        <ul className="space-y-2">
          {recent.map((e) => (
            <li
              key={e.id}
              className={`flex items-center justify-between rounded-xl px-4 py-2 ${
                e.held
                  ? "bg-[var(--hold)] text-white"
                  : "bg-[var(--surface)]"
              }`}
            >
              <span className="font-display text-4xl font-bold">{e.number}</span>
              <span className="text-base font-semibold">
                {laneLabel(school, e.lane)} · {t.wave} {e.waveNumber} · {t.spot}{" "}
                {e.spot}
                {e.held ? ` · ⛔ HOLD` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BoardView({
  data,
  school,
  t,
  off,
}: {
  data: State;
  school: School;
  t: TDict;
  off: OfflineApi;
}) {
  const queryClient = useQueryClient();
  const seenRef = useRef<Set<number>>(new Set());
  const [fresh, setFresh] = useState<Set<number>>(new Set());

  useEffect(() => {
    const ids = data.entries.map((e) => e.id);
    const newIds = ids.filter((id) => !seenRef.current.has(id));
    if (seenRef.current.size > 0 && newIds.length > 0) {
      setFresh(new Set(newIds));
      const timer = setTimeout(() => setFresh(new Set()), 3600);
      return () => clearTimeout(timer);
    }
    ids.forEach((id) => seenRef.current.add(id));
    if (newIds.length > 0) {
      const s = new Set(seenRef.current);
      newIds.forEach((id) => s.add(id));
      seenRef.current = s;
    }
  }, [data.entries]);

  const holdMut = useMutation({
    mutationFn: (args: { number: string; held: boolean }) =>
      args.held ? api.clearHold({ number: args.number }) : api.setHold({ number: args.number }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });

  const isHeld = (e: Entry) => off.effectiveHolds.has(e.number);
  const toggleHold = (e: Entry) => {
    if (off.offline) {
      off.enqueue({
        kind: isHeld(e) ? "clearHold" : "hold",
        number: e.number,
        lane: e.lane,
      });
    } else {
      holdMut.mutate({ number: e.number, held: e.held });
    }
  };

  const lanes = lanesOf(school);
  const active = data.entries.filter(
    (e) => e.status !== "departed" && e.status !== "no_show",
  );

  const laneAccent = (lane: string) =>
    lane === "left"
      ? "border-[var(--left)]"
      : lane === "right"
        ? "border-[var(--right)]"
        : "border-[var(--border)]";
  const laneHead = (lane: string) =>
    lane === "left"
      ? "bg-[var(--left)] text-[#0b1d3a]"
      : lane === "right"
        ? "bg-[var(--right)] text-white"
        : "bg-[var(--text)] text-[var(--bg)]";

  return (
    <div
      className={`grid gap-4 ${lanes.length === 2 ? "sm:grid-cols-2" : "mx-auto max-w-xl"}`}
    >
      {lanes.map((lane) => {
        const laneEntries = active.filter((e) => e.lane === lane);
        const waveNums = [...new Set(laneEntries.map((e) => e.waveNumber))].sort(
          (a, b) => a - b,
        );
        return (
          <section
            key={lane}
            aria-label={laneLabel(school, lane)}
            className={`overflow-hidden rounded-2xl border-4 bg-[var(--surface)] ${laneAccent(lane)}`}
          >
            <h2
              className={`px-4 py-3 text-center font-display text-3xl font-bold uppercase ${laneHead(lane)}`}
            >
              {laneLabel(school, lane)}
            </h2>
            <div className="space-y-4 p-3">
              {waveNums.length === 0 && (
                <p className="py-8 text-center text-xl font-semibold text-[var(--dim)]">
                  —
                </p>
              )}
              {waveNums.map((wn) => (
                <div key={wn}>
                  <p className="mb-2 text-base font-bold uppercase tracking-widest text-[var(--dim)]">
                    {t.wave} {wn}
                  </p>
                  <ul className="space-y-2">
                    {laneEntries
                      .filter((e) => e.waveNumber === wn)
                      .map((e) => (
                        <li
                          key={e.id}
                          className={`flex items-center gap-3 rounded-xl px-3 py-2 ${
                            isHeld(e)
                              ? "bg-[var(--hold)] text-white"
                              : e.status === "loaded"
                                ? "bg-[var(--go)] text-white"
                                : "bg-[var(--surface2)]"
                          } ${fresh.has(e.id) ? "rt-flash" : ""}`}
                        >
                          <span className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-lg bg-black/20 text-white">
                            <span className="text-[10px] font-bold uppercase leading-none">
                              {t.spot}
                            </span>
                            <span className="font-display text-2xl font-bold leading-none">
                              {e.spot}
                            </span>
                          </span>
                          <span className="font-display text-6xl font-bold leading-none">
                            {e.number}
                          </span>
                          <span className="ml-auto flex flex-col items-end gap-1">
                            <span className="text-sm font-bold uppercase">
                              {isHeld(e) ? "⛔ HOLD" : t.status[e.status]}
                            </span>
                            <button
                              type="button"
                              aria-label={
                                isHeld(e)
                                  ? `${t.clearHold} ${e.number}`
                                  : `HOLD ${e.number}`
                              }
                              onClick={() => toggleHold(e)}
                              className={`min-h-10 rounded-lg px-3 text-sm font-bold ${
                                isHeld(e)
                                  ? "bg-white text-[var(--hold)]"
                                  : "bg-[var(--hold)] text-white"
                              }`}
                            >
                              {isHeld(e) ? t.clearHold : "HOLD"}
                            </button>
                          </span>
                        </li>
                      ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function LoaderView({
  data,
  school,
  t,
  off,
}: {
  data: State;
  school: School;
  t: TDict;
  off: OfflineApi;
}) {
  const queryClient = useQueryClient();
  const dual = school.laneMode === "dual";
  const [lane, setLane] = useState<string>(dual ? "left" : "main");
  useEffect(() => {
    if (!dual) setLane("main");
  }, [dual]);

  const advanceMut = useMutation({
    mutationFn: (id: number) => api.advanceEntry({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  const noShowMut = useMutation({
    mutationFn: (id: number) => api.markNoShow({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  const releaseMut = useMutation({
    mutationFn: (waveId: number) => api.releaseWave({ waveId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });

  const openWaves = data.waves
    .filter((w) => w.lane === lane && w.status === "open")
    .sort((a, b) => a.number - b.number);
  const current = openWaves.find((w) =>
    data.entries.some((e) => e.waveId === w.id && e.status !== "no_show"),
  );
  const entries = current
    ? data.entries.filter((e) => e.waveId === current.id)
    : [];
  const visible = entries.filter((e) => e.status !== "departed");
  const inCount = visible.length;
  const readyCount = visible.filter(
    (e) => e.status === "loaded" || e.status === "no_show",
  ).length;
  const allReady = inCount > 0 && readyCount === inCount;
  const nextWave = current
    ? openWaves.find((w) => w.number > current.number)
    : undefined;
  const nextCount = nextWave
    ? data.entries.filter((e) => e.waveId === nextWave.id).length
    : 0;

  const isHeld = (e: Entry) => off.effectiveHolds.has(e.number);

  const nextLabel = (e: Entry): string => {
    if (e.status === "entered") return `→ ${t.onBoard}`;
    if (e.status === "on_board") return `→ ${t.atSpot}`;
    if (e.status === "at_spot") return t.markLoaded;
    return t.status[e.status] ?? e.status;
  };

  return (
    <div className="mx-auto max-w-xl">
      {dual && (
        <div className="mb-3 grid grid-cols-2 gap-2" role="group" aria-label="Lane">
          <button
            type="button"
            aria-label={t.leftLine}
            aria-pressed={lane === "left"}
            onClick={() => setLane("left")}
            className={`flex min-h-16 items-center justify-center gap-1.5 whitespace-nowrap rounded-2xl px-2 font-display font-bold leading-none sm:gap-2 ${
              lane === "left"
                ? "bg-[var(--left)] text-[#0b1d3a]"
                : "border-2 border-[var(--left)] bg-[var(--surface)] text-[var(--left-dark)]"
            }`}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              fill="currentColor"
              className="h-5 w-5 shrink-0"
            >
              <path d="M11.5 1.5 4.5 8l7 6.5z" />
            </svg>
            <span className="min-w-0 whitespace-nowrap text-[clamp(0.95rem,4.6vw,1.5rem)] leading-none">
              {school.leftLabel}
            </span>
          </button>
          <button
            type="button"
            aria-label={t.rightLine}
            aria-pressed={lane === "right"}
            onClick={() => setLane("right")}
            className={`flex min-h-16 items-center justify-center gap-1.5 whitespace-nowrap rounded-2xl px-2 font-display font-bold leading-none sm:gap-2 ${
              lane === "right"
                ? "bg-[var(--right)] text-white"
                : "border-2 border-[var(--right)] bg-[var(--surface)] text-[var(--right)]"
            }`}
          >
            <span className="min-w-0 whitespace-nowrap text-[clamp(0.95rem,4.6vw,1.5rem)] leading-none">
              {school.rightLabel}
            </span>
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              fill="currentColor"
              className="h-5 w-5 shrink-0"
            >
              <path d="M4.5 1.5 11.5 8l-7 6.5z" />
            </svg>
          </button>
        </div>
      )}

      {!current ? (
        <p className="py-10 text-center text-xl font-semibold text-[var(--dim)]">
          {t.noCarsYet}
        </p>
      ) : (
        <>
          <div className="mb-3 flex items-end justify-between">
            <h2 className="font-display text-4xl font-bold uppercase">
              {t.wave} {current.number}
            </h2>
            <p className="text-2xl font-bold">
              {inCount} in / {readyCount} {t.ready}
            </p>
          </div>
          <ul className="space-y-2">
            {visible.map((e) => (
              <li
                key={e.id}
                className={`rounded-2xl p-3 ${
                  isHeld(e)
                    ? "bg-[var(--hold)] text-white"
                    : e.status === "no_show"
                      ? "bg-[var(--surface2)] opacity-60"
                      : e.status === "loaded"
                        ? "bg-[var(--go)] text-white"
                        : "bg-[var(--surface)]"
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className="font-display text-6xl font-bold leading-none">
                    {e.number}
                  </span>
                  <span className="text-base font-bold uppercase">
                    {t.spot} {e.spot} · {isHeld(e) ? "⛔ HOLD" : t.status[e.status]}
                  </span>
                </div>
                {isHeld(e) ? (
                  <p className="mt-2 text-lg font-bold uppercase">{t.holdAlert}</p>
                ) : e.status === "no_show" ? null : e.status === "loaded" ? (
                  <p className="mt-2 text-lg font-bold">✓ {t.status.loaded}</p>
                ) : (
                  <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
                    <button
                      type="button"
                      aria-label={`${nextLabel(e)} — ${e.number}`}
                      disabled={advanceMut.isPending || off.offline}
                      onClick={() => advanceMut.mutate(e.id)}
                      className="min-h-16 rounded-xl bg-[var(--text)] font-display text-2xl font-bold text-[var(--bg)]"
                    >
                      {nextLabel(e)}
                    </button>
                    <button
                      type="button"
                      aria-label={`${t.noShow} — ${e.number}`}
                      disabled={off.offline}
                      onClick={() => noShowMut.mutate(e.id)}
                      className="min-h-16 rounded-xl border-2 border-current px-4 text-lg font-bold"
                    >
                      {t.noShow}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <button
            type="button"
            aria-label={`${t.releaseWave} ${current.number}`}
            disabled={!allReady || releaseMut.isPending || off.offline}
            onClick={() => releaseMut.mutate(current.id)}
            className="mt-4 min-h-20 w-full rounded-2xl bg-[var(--text)] font-display text-3xl font-bold text-[var(--bg)] disabled:opacity-40"
          >
            {t.releaseWave} · {inCount} in / {readyCount} {t.ready}
          </button>
          {nextWave && (
            <p className="mt-3 text-center text-lg font-semibold text-[var(--dim)]">
              {t.wave} {nextWave.number}: {nextCount}{" "}
              {nextCount === 1 ? "car" : "cars"}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function SummaryBlock({
  summary,
  t,
}: {
  summary: NonNullable<State["lastSummary"]>;
  t: TDict;
}) {
  return (
    <section
      aria-label={t.daySummary}
      className="rounded-2xl bg-[var(--surface)] p-4"
    >
      <h3 className="font-display text-3xl font-bold uppercase">
        {t.daySummary}
      </h3>
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-xl bg-[var(--surface2)] p-3">
          <p className="font-display text-5xl font-bold">{summary.totalLoaded}</p>
          <p className="text-sm font-bold uppercase">{t.carsLoaded}</p>
        </div>
        <div className="rounded-xl bg-[var(--surface2)] p-3">
          <p className="font-display text-5xl font-bold">{summary.wavesRun}</p>
          <p className="text-sm font-bold uppercase">{t.wavesRun}</p>
        </div>
        <div className="rounded-xl bg-[var(--surface2)] p-3">
          <p className="font-display text-5xl font-bold">{summary.totalNoShow}</p>
          <p className="text-sm font-bold uppercase">{t.noShows}</p>
        </div>
      </div>
      <p className="mt-3 text-lg font-semibold">
        {t.firstCar}: {fmtTime(summary.firstCarAt)} · {t.lastCar}:{" "}
        {fmtTime(summary.lastCarAt)}
      </p>
      <p className="mt-1 text-base text-[var(--dim)]">{t.numbersCleared}</p>
    </section>
  );
}

function ProofReport({
  summaries,
  t,
  lang,
}: {
  summaries: DaySummary[];
  t: TDict;
  lang: Lang;
}) {
  const locale = lang === "es" ? "es" : "en";
  const fmtDate = (s: DaySummary): string =>
    new Date(`${s.date}T12:00:00`).toLocaleDateString(locale, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

  if (summaries.length === 0) {
    return (
      <section
        aria-label={t.proofReport}
        className="rounded-2xl bg-[var(--surface)] p-4"
      >
        <h2 className="font-display text-3xl font-bold uppercase">
          {t.proofReport}
        </h2>
        <p className="mt-2 text-lg font-medium text-[var(--dim)]">
          {t.proofEmpty}
        </p>
      </section>
    );
  }

  const latest = summaries[summaries.length - 1];
  if (!latest) return null;
  const latestDur = summaryDurationMs(latest);
  const latestSentence =
    `${t.dismissalComplete}` +
    (latestDur != null
      ? ` ${t.inWord} ${fmtDurationMs(latestDur, t)}`
      : "") +
    ` · ${latest.totalLoaded} ${latest.totalLoaded === 1 ? t.carWord : t.carsWord}` +
    ` · ${latest.wavesRun} ${latest.wavesRun === 1 ? t.waveWord : t.wavesWord}` +
    ` · ${latest.stillWaiting} ${t.stillWaitingLabel}`;

  // Semester aggregates. Durations only from days that have them; counts
  // (cars, days) include every recorded day, legacy rows included.
  const durations = summaries
    .map(summaryDurationMs)
    .filter((d): d is number => d != null);
  const avgMs =
    durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : null;
  const fastestMs = durations.length > 0 ? Math.min(...durations) : null;
  const totalCars = summaries.reduce((a, s) => a + s.totalLoaded, 0);

  // Trend only with ≥4 days that have durations: average of the first 3
  // recorded days vs the most recent 3, honest within a 1-minute band.
  let trend: string | null = null;
  if (durations.length >= 4) {
    const avgOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const diff = avgOf(durations.slice(0, 3)) - avgOf(durations.slice(-3));
    const diffMin = Math.round(Math.abs(diff) / 60000);
    if (diff >= 60000) {
      trend = `${t.trendIs} ${diffMin} ${t.minWord} ${t.trendFaster}`;
    } else if (diff <= -60000) {
      trend = `${t.trendIs} ${diffMin} ${t.minWord} ${t.trendSlower}`;
    } else {
      trend = t.trendSame;
    }
  }

  const history = [...summaries].reverse();
  const statTile = (value: string, label: string) => (
    <div className="rounded-xl bg-[var(--surface2)] p-3 text-center">
      <p className="font-display text-4xl font-bold leading-tight">{value}</p>
      <p className="text-sm font-bold uppercase">{label}</p>
    </div>
  );

  return (
    <section
      aria-label={t.proofReport}
      className="rounded-2xl bg-[var(--surface)] p-4"
    >
      <h2 className="font-display text-3xl font-bold uppercase">
        {t.proofReport}
      </h2>

      <div className="mt-3 rounded-xl bg-[var(--text)] px-4 py-4 text-[var(--bg)]">
        <p className="text-sm font-bold uppercase tracking-wide opacity-80">
          {t.proofLatest} · {fmtDate(latest)}
        </p>
        <p className="mt-1 text-2xl font-bold leading-snug">{latestSentence}</p>
        <p className="mt-1 text-base font-semibold opacity-80">
          {t.holdsPlacedLabel}: {latest.holdsPlaced}
        </p>
      </div>

      <h3 className="mt-5 text-lg font-bold uppercase tracking-wide text-[var(--dim)]">
        {t.proofSemester}
      </h3>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {statTile(avgMs != null ? fmtDurationMs(avgMs, t) : "—", t.avgDismissal)}
        {statTile(
          fastestMs != null ? fmtDurationMs(fastestMs, t) : "—",
          t.fastestDay,
        )}
        {statTile(String(totalCars), t.totalCarsMoved)}
        {statTile(String(summaries.length), t.daysRecorded)}
      </div>
      {trend && (
        <p className="mt-3 rounded-xl bg-[var(--surface2)] px-4 py-3 text-lg font-bold leading-snug">
          📈 {trend}
        </p>
      )}

      <h3 className="mt-5 text-lg font-bold uppercase tracking-wide text-[var(--dim)]">
        {t.proofHistory}
      </h3>
      <ul className="mt-2 space-y-2">
        {history.map((s, i) => {
          const dur = summaryDurationMs(s);
          const noShows = s.totalNoShow + s.stillWaiting;
          return (
            <li key={`${s.endedAt}-${i}`} className="rounded-xl bg-[var(--surface2)] px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-lg font-bold">{fmtDate(s)}</span>
                <span className="font-display text-2xl font-bold">
                  {dur != null ? fmtDurationMs(dur, t) : "—"}
                </span>
              </div>
              <p className="mt-0.5 text-base font-medium text-[var(--dim)]">
                {s.totalLoaded} {s.totalLoaded === 1 ? t.carWord : t.carsWord}
                {" · "}
                {s.wavesRun} {s.wavesRun === 1 ? t.waveWord : t.wavesWord}
                {" · "}
                {noShows} {t.noShowWord}
                {" · "}
                {s.holdsPlaced} {t.holdsPlacedLabel}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function OfficeView({
  data,
  school,
  t,
  off,
  lang,
}: {
  data: State;
  school: School;
  t: TDict;
  off: OfflineApi;
  lang: Lang;
}) {
  const queryClient = useQueryClient();
  const [holdInput, setHoldInput] = useState("");
  const [armEnd, setArmEnd] = useState(false);
  const [justEnded, setJustEnded] = useState(false);

  const setHoldMut = useMutation({
    mutationFn: (num: string) => api.setHold({ number: num }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      setHoldInput("");
    },
  });
  const clearHoldMut = useMutation({
    mutationFn: (num: string) => api.clearHold({ number: num }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  const endMut = useMutation({
    mutationFn: () => api.endDismissal({}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      setArmEnd(false);
      setJustEnded(true);
    },
  });

  // Holds set while offline queue in the outbox and apply on sync; the
  // list below shows this device's effective holds, queued ones included.
  const handleSetHold = () => {
    const num = holdInput.trim();
    if (!num) return;
    if (off.offline) {
      off.enqueue({ kind: "hold", number: num, lane: "main" });
      setHoldInput("");
      return;
    }
    setHoldMut.mutate(num);
  };
  const handleClearHold = (num: string) => {
    if (off.offline) {
      off.enqueue({ kind: "clearHold", number: num, lane: "main" });
      return;
    }
    clearHoldMut.mutate(num);
  };
  const holdList = [...off.effectiveHolds];

  const waiting = data.entries.filter(
    (e) =>
      e.status !== "loaded" && e.status !== "departed" && e.status !== "no_show",
  );
  const showSummary =
    (justEnded || waiting.length === 0) && data.lastSummary != null;

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <section aria-label={t.waitingCars}>
        <h2 className="font-display text-4xl font-bold uppercase">
          {t.waitingCars} ({waiting.length})
        </h2>
        <p className="mt-1 text-base font-medium text-[var(--dim)]">
          {t.waitingHelp}
        </p>
        {waiting.length === 0 ? (
          <p className="mt-3 rounded-2xl bg-[var(--go)] px-4 py-4 text-center text-xl font-bold text-white">
            ✓ {t.nobodyWaiting}
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {waiting.map((e) => (
              <li
                key={e.id}
                className={`flex items-center justify-between rounded-xl px-4 py-2 ${
                  off.effectiveHolds.has(e.number)
                    ? "bg-[var(--hold)] text-white"
                    : "bg-[var(--surface)]"
                }`}
              >
                <span className="font-display text-5xl font-bold">{e.number}</span>
                <span className="text-right text-base font-semibold">
                  {laneLabel(school, e.lane)} · {t.wave} {e.waveNumber} ·{" "}
                  {t.spot} {e.spot}
                  <br />
                  {off.effectiveHolds.has(e.number)
                    ? "⛔ HOLD"
                    : t.status[e.status]}{" "}
                  ·{" "}
                  {fmtTime(e.enteredAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label={t.holds} className="rounded-2xl bg-[var(--surface)] p-4">
        <h2 className="font-display text-3xl font-bold uppercase">{t.holds}</h2>
        <p className="mt-1 text-base text-[var(--dim)]">{t.holdsHelp}</p>
        <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
          <input
            aria-label={t.holdNumberPlaceholder}
            inputMode="numeric"
            value={holdInput}
            onChange={(ev) => setHoldInput(ev.target.value.replace(/\D/g, ""))}
            placeholder={t.holdNumberPlaceholder}
            className="min-h-16 min-w-0 w-full rounded-xl border-2 border-[var(--border)] bg-[var(--bg)] px-4 font-display text-3xl font-semibold"
          />
          <button
            type="button"
            aria-label={t.setHold}
            disabled={holdInput.length === 0 || (!off.offline && setHoldMut.isPending)}
            onClick={handleSetHold}
            className="min-h-16 rounded-xl bg-[var(--hold)] px-4 font-display text-2xl font-bold text-white disabled:opacity-40"
          >
            {t.setHold}
          </button>
        </div>
        {holdList.length > 0 && (
          <ul className="mt-3 space-y-2">
            {holdList.map((num) => (
              <li
                key={num}
                className="flex items-center justify-between rounded-xl bg-[var(--hold)] px-4 py-2 text-white"
              >
                <span className="font-display text-4xl font-bold">
                  ⛔ {num}
                  {!data.holds.includes(num) && (
                    <span className="ml-2 align-middle text-base font-bold uppercase">
                      📵 {t.queuedTag}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  aria-label={`${t.clearHold} ${num}`}
                  onClick={() => handleClearHold(num)}
                  className="min-h-12 rounded-lg bg-white px-4 text-lg font-bold text-[var(--hold)]"
                >
                  {t.clearHold}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {showSummary && data.lastSummary && (
        <SummaryBlock summary={data.lastSummary} t={t} />
      )}

      <ProofReport summaries={data.summaries} t={t} lang={lang} />

      <button
        type="button"
        aria-label={armEnd ? t.endConfirm : t.endDismissal}
        disabled={off.offline}
        onClick={() => {
          if (armEnd) endMut.mutate();
          else {
            setArmEnd(true);
            setTimeout(() => setArmEnd(false), 4000);
          }
        }}
        className={`min-h-20 w-full rounded-2xl font-display text-3xl font-bold text-white disabled:opacity-40 ${
          armEnd ? "bg-[var(--hold)]" : "bg-[var(--text)]"
        }`}
      >
        {armEnd ? t.endConfirm : t.endDismissal}
      </button>
    </div>
  );
}

function HelpView({
  lang,
  t,
  onGo,
}: {
  lang: Lang;
  t: TDict;
  onGo: (v: View) => void;
}) {
  const h = HELP[lang];
  const scrollTo = (id: string) => {
    document
      .getElementById(`help-${id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const sectionCard = (
    id: string,
    title: string,
    purpose: string,
    steps: string[],
    tip: string,
    goView?: View,
    goLabel?: string,
  ) => (
    <section
      key={id}
      id={`help-${id}`}
      aria-label={title}
      className="scroll-mt-4 rounded-2xl bg-[var(--surface)] p-4"
    >
      <h3 className="font-display text-3xl font-bold uppercase leading-tight">
        {title}
      </h3>
      <p className="mt-1 text-xl font-semibold leading-snug">{purpose}</p>
      <ol className="mt-3 space-y-3">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--text)] font-display text-xl font-bold text-[var(--bg)]">
              {i + 1}
            </span>
            <span className="pt-1 text-lg font-medium leading-snug">{s}</span>
          </li>
        ))}
      </ol>
      <p className="mt-4 rounded-xl bg-[var(--surface2)] px-4 py-3 text-lg font-bold leading-snug">
        ★ {h.rememberLabel}: {tip}
      </p>
      {goView && goLabel && (
        <button
          type="button"
          aria-label={`${h.openLabel}: ${goLabel} (${title})`}
          onClick={() => onGo(goView)}
          className="mt-3 min-h-16 w-full rounded-2xl bg-[var(--text)] font-display text-2xl font-bold uppercase text-[var(--bg)]"
        >
          {goLabel} →
        </button>
      )}
    </section>
  );

  const goFor: Record<string, { view: View; label: string }> = {
    setup: { view: "setup", label: t.setup },
    walker: { view: "walker", label: t.walker },
    board: { view: "board", label: t.board },
    loader: { view: "loader", label: t.loader },
    office: { view: "office", label: t.office },
    offline: { view: "walker", label: t.walker },
    holds: { view: "office", label: t.office },
  };

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div className="flex items-center gap-4">
        <RiderTapLogo size={64} />
        <div>
          <p className="font-display text-xl font-bold uppercase leading-none tracking-wide text-[var(--dim)]">
            RiderTap
          </p>
          <h2 className="mt-1 font-display text-4xl font-bold uppercase leading-none">
            {h.title}
          </h2>
          <p className="mt-1 text-lg font-medium text-[var(--dim)]">{h.intro}</p>
        </div>
      </div>

      <nav aria-label={h.title} className="grid grid-cols-2 gap-2">
        <button
          type="button"
          aria-label={`${h.jumpLabel}: ${h.quickTitle}`}
          onClick={() => scrollTo("quick")}
          className="min-h-14 rounded-xl bg-[var(--go)] px-3 text-lg font-bold text-white"
        >
          ▶ {h.quickTitle}
        </button>
        {h.sections.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-label={`${h.jumpLabel}: ${s.title}`}
            onClick={() => scrollTo(s.id)}
            className="min-h-14 rounded-xl border-2 border-[var(--border)] bg-[var(--surface)] px-3 text-lg font-bold"
          >
            {s.title}
          </button>
        ))}
      </nav>

      {sectionCard(
        "quick",
        h.quickTitle,
        h.quickPurpose,
        h.quickSteps,
        h.quickTip,
        "walker",
        t.walker,
      )}

      {h.sections.map((s) =>
        sectionCard(
          s.id,
          s.title,
          s.purpose,
          s.steps,
          s.tip,
          goFor[s.id]?.view,
          goFor[s.id]?.label,
        ),
      )}
    </div>
  );
}

function SetupView({
  school,
  t,
  off,
}: {
  school: School;
  t: TDict;
  off: OfflineApi;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<School>(school);
  const [savedTick, setSavedTick] = useState(false);

  useEffect(() => {
    setForm(school);
  }, [school]);

  const saveMut = useMutation({
    mutationFn: (f: School) => api.saveSetup(f),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 2500);
    },
  });
  // Production: the Setup screen's second button is "Change school code"
  // (the t.resetDemo string) — it forgets this device's join code and
  // reloads into the join gate. There is no client-side demo reset in
  // production; resetDemo is not a ported action.
  const resetMut = useMutation({
    mutationFn: async () => {
      clearSchoolCode();
    },
    onSuccess: () => window.location.reload(),
  });

  const field =
    "min-h-14 w-full rounded-xl border-2 border-[var(--border)] bg-[var(--surface)] px-4 text-lg font-medium";
  const labelCls = "mb-1 block text-base font-bold uppercase tracking-wide text-[var(--dim)]";

  const textField = (
    key: keyof School,
    label: string,
  ): ReactNode => (
    <div>
      <label htmlFor={`f-${key}`} className={labelCls}>
        {label}
      </label>
      <input
        id={`f-${key}`}
        aria-label={label}
        value={String(form[key])}
        onChange={(ev) => setForm({ ...form, [key]: ev.target.value })}
        className={field}
      />
    </div>
  );

  const typeBtn = (value: string, short: string, full: string) => (
    <button
      key={value}
      type="button"
      aria-label={full}
      aria-pressed={form.schoolType === value}
      onClick={() => setForm({ ...form, schoolType: value })}
      className={`min-h-16 rounded-xl font-display text-3xl font-bold tracking-wide ${
        form.schoolType === value
          ? "bg-[var(--text)] text-[var(--bg)]"
          : "border-2 border-[var(--border)] bg-[var(--surface)]"
      }`}
    >
      {short}
    </button>
  );

  const selectedTypeShort =
    form.schoolType === "middle"
      ? t.middleShort
      : form.schoolType === "high"
        ? t.highShort
        : t.elementaryShort;
  const selectedTypeFull =
    form.schoolType === "middle"
      ? t.middleFull
      : form.schoolType === "high"
        ? t.highFull
        : t.elementaryFull;

  return (
    <div className="mx-auto max-w-xl">
      <div className="flex items-center gap-4 rounded-2xl bg-[#0b1d3a] p-4">
        <RiderTapLogo size={76} />
        <div>
          <p className="font-display text-3xl font-bold uppercase leading-none tracking-wide text-white">
            RiderTap
          </p>
          <p className="mt-1.5 text-base font-semibold leading-snug text-white/80">
            {t.tagline}
          </p>
          <p className="mt-1 text-sm font-semibold uppercase tracking-wide text-white/60">
            {school.name}
          </p>
        </div>
      </div>
      <h2 className="mt-5 font-display text-4xl font-bold uppercase">{t.setupTitle}</h2>
      <div className="mt-4">
        <OfflineToggle off={off} t={t} big />
        <p className="mt-2 text-base font-medium text-[var(--dim)]">
          {t.offline}: {t.willSync}
        </p>
      </div>
      <div className="mt-4 space-y-4">
        {textField("name", t.schoolName)}
        <div>
          <label htmlFor="f-district" className={labelCls}>
            {t.district}
          </label>
          <textarea
            id="f-district"
            aria-label={t.district}
            rows={2}
            value={form.district}
            onChange={(ev) => setForm({ ...form, district: ev.target.value })}
            className="min-h-14 w-full resize-none whitespace-normal break-words rounded-xl border-2 border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-lg font-medium leading-snug"
          />
        </div>
        {textField("county", t.county)}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {textField("state", t.state)}
          <div>
            <span className={labelCls}>{t.schoolType}</span>
            <div className="grid grid-cols-3 gap-2">
              {typeBtn("elementary", t.elementaryShort, t.elementaryFull)}
              {typeBtn("middle", t.middleShort, t.middleFull)}
              {typeBtn("high", t.highShort, t.highFull)}
            </div>
            <p aria-live="polite" className="mt-2 text-base font-bold">
              {t.selectedType}: {selectedTypeShort} — {selectedTypeFull}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="f-start" className={labelCls}>
              {t.start}
            </label>
            <input
              id="f-start"
              aria-label={t.start}
              type="time"
              value={form.dismissalStart}
              onChange={(ev) => setForm({ ...form, dismissalStart: ev.target.value })}
              className={field}
            />
          </div>
          <div>
            <label htmlFor="f-end" className={labelCls}>
              {t.end}
            </label>
            <input
              id="f-end"
              aria-label={t.end}
              type="time"
              value={form.dismissalEnd}
              onChange={(ev) => setForm({ ...form, dismissalEnd: ev.target.value })}
              className={field}
            />
          </div>
        </div>
        <div>
          <label htmlFor="f-spots" className={labelCls}>
            {t.spots}
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Fewer spots"
              onClick={() =>
                setForm({ ...form, spotsPerWave: Math.max(1, form.spotsPerWave - 1) })
              }
              className="min-h-14 w-16 rounded-xl border-2 border-[var(--border)] bg-[var(--surface)] font-display text-3xl font-bold"
            >
              −
            </button>
            <input
              id="f-spots"
              aria-label={t.spots}
              type="number"
              min={1}
              max={30}
              value={form.spotsPerWave}
              onChange={(ev) =>
                setForm({
                  ...form,
                  spotsPerWave: Math.max(1, Math.min(30, Number(ev.target.value) || 8)),
                })
              }
              className={`${field} text-center font-display text-3xl font-semibold`}
            />
            <button
              type="button"
              aria-label="More spots"
              onClick={() =>
                setForm({ ...form, spotsPerWave: Math.min(30, form.spotsPerWave + 1) })
              }
              className="min-h-14 w-16 rounded-xl border-2 border-[var(--border)] bg-[var(--surface)] font-display text-3xl font-bold"
            >
              +
            </button>
          </div>
        </div>
        <div>
          <span className={labelCls}>{t.laneConfig}</span>
          <div className="grid grid-cols-1 gap-2">
            <button
              type="button"
              aria-label={t.singleFile}
              aria-pressed={form.laneMode === "single"}
              onClick={() => setForm({ ...form, laneMode: "single" })}
              className={`min-h-16 rounded-xl font-display text-2xl font-bold ${
                form.laneMode === "single"
                  ? "bg-[var(--text)] text-[var(--bg)]"
                  : "border-2 border-[var(--border)] bg-[var(--surface)]"
              }`}
            >
              {t.singleFile}
            </button>
            <button
              type="button"
              aria-label={t.twoLines}
              aria-pressed={form.laneMode === "dual"}
              onClick={() => setForm({ ...form, laneMode: "dual" })}
              className={`min-h-16 rounded-xl font-display text-2xl font-bold ${
                form.laneMode === "dual"
                  ? "bg-[var(--text)] text-[var(--bg)]"
                  : "border-2 border-[var(--border)] bg-[var(--surface)]"
              }`}
            >
              {t.twoLines}
            </button>
          </div>
        </div>
        {form.laneMode === "dual" && (
          <div className="grid grid-cols-2 gap-3">
            {textField("leftLabel", t.leftLabel)}
            {textField("rightLabel", t.rightLabel)}
          </div>
        )}
        <button
          type="button"
          aria-label={t.save}
          disabled={saveMut.isPending}
          onClick={() => saveMut.mutate(form)}
          className="min-h-[72px] w-full rounded-2xl bg-[var(--go)] font-display text-3xl font-bold text-white disabled:opacity-50"
        >
          {savedTick ? t.saved : t.save}
        </button>
        <button
          type="button"
          aria-label={t.resetDemo}
          disabled={resetMut.isPending}
          onClick={() => resetMut.mutate()}
          className="min-h-14 w-full rounded-2xl border-2 border-[var(--border)] bg-[var(--surface)] text-lg font-bold"
        >
          {t.resetDemo}
        </button>
      </div>
    </div>
  );
}
