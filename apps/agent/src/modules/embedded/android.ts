/**
 * Android: modo desenvolvedor, depuração USB e fatos documentados sobre
 * Knox Guard / FRP / MDM.
 *
 * Postura do módulo:
 * - O modo desenvolvedor é uma configuração local do aparelho. Os passos
 *   oficiais são documentados, mas ativar depuração USB em aparelho de
 *   terceiros exige consentimento do proprietário.
 * - Knox Guard, FRP e MDM NÃO são contornados. A remoção legítima passa pelo
 *   provedor, operadora, administrador de TI ou suporte oficial.
 * - Comandos ADB são separados entre somente-leitura e alteração de estado.
 *   Sem `authorized: true`, apenas leitura é devolvida.
 */

export type AndroidOs = "android" | "samsung-knox";

export interface DeveloperModeGuide {
  os: AndroidOs;
  steps: string[];
  notes: string[];
  officialReferences: string[];
}

export interface KnoxFact {
  id: string;
  statement: string;
  source: string;
}

export interface KnoxGuardFacts {
  requiresConsent: true;
  summary: string;
  facts: KnoxFact[];
  lawfulRemoval: string[];
  legalImplications: string[];
  officialChannels: string[];
  /** O que o módulo se recusa a fazer (e por quê). */
  notProvided: string[];
}

export type AdbMode = "read-only" | "diagnostics";

export interface AdbCommandsInput {
  authorized: boolean;
  mode?: AdbMode;
}

export interface AdbCommandSet {
  authorized: boolean;
  mode: AdbMode;
  readOnly: string[];
  stateChanging: string[];
  withheld: string[];
  notes: string[];
}

export interface ChecklistItem {
  id: string;
  question: string;
  required: boolean;
  evidence: string;
}

/** Passos oficiais para habilitar Opções do desenvolvedor e depuração USB. */
export function developerModeSteps(os: AndroidOs = "android"): DeveloperModeGuide {
  const isKnox = os === "samsung-knox";
  const steps = [
    "Abra Ajustes (Configurações) no aparelho.",
    "Vá em Sobre o telefone (ou Sobre o dispositivo).",
    isKnox
      ? "Toque em Informações do software e localize Número da versão."
      : "Localize Número da versão (Build number).",
    "Toque em Número da versão 7 vezes seguidas. A partir da 3ª tentativa o sistema mostra quantos toques faltam.",
    "Confirme o PIN, padrão ou senha da tela de bloqueio quando solicitado.",
    "Volte para Ajustes > Sistema > Opções do desenvolvedor (em versões antigas, o menu aparece em Ajustes).",
    "Ative Depuração USB (USB debugging).",
    "Conecte o cabo USB e, se aparecer o diálogo, autorize a impressão digital RSA do computador marcando \"Sempre permitir\" apenas em máquina confiável.",
    "Valide no computador com `adb devices -l`: o estado deve ser `device`; `unauthorized` significa que o diálogo ainda não foi aceito.",
  ];

  const notes = [
    "Ativar o modo desenvolvedor não desbloqueia bootloader, não remove FRP/Knox e não dá root.",
    "A depuração USB permite ler dados do aparelho; faça isso somente no seu aparelho ou com autorização escrita do proprietário.",
    "Em aparelho corporativo, políticas de MDM podem ocultar ou desabilitar Opções do desenvolvedor. Procure o administrador de TI; não tente contornar a política.",
  ];

  if (isKnox) {
    notes.push(
      "Knox Guard é um serviço separado do modo desenvolvedor. Ele pode manter o aparelho bloqueado mesmo com depuração USB habilitada.",
      "Se a tela de Download Mode mostrar KG STATE ou RMM STATE, o desbloqueio depende do provedor/MDM autorizado; não existe comando ADB ou fastboot legítimo para removê-lo.",
      "Este guia não remove Knox Guard, FRP nem inscrição de MDM. Ele apenas documenta os passos oficiais e os canais corretos.",
    );
  }

  return {
    os,
    steps,
    notes,
    officialReferences: [
      "Android Developers — Configure on-device developer options: https://developer.android.com/studio/debug/dev-options",
      "Android Developers — adb: https://developer.android.com/tools/adb",
      "Samsung Knox — Knox Guard: https://www.samsungknox.com/en/solutions/knox-guard",
      "Samsung Knox — MDM/EMM: https://www.samsungknox.com/en/solutions/enterprise-mobility-management",
    ],
  };
}

/**
 * Fatos documentados sobre Knox Guard, FRP e MDM. Não é instrução de remoção:
 * a remoção legítima exige provedor/MDM autorizado e comprovação de titularidade.
 */
export function knoxGuardFacts(): KnoxGuardFacts {
  return {
    requiresConsent: true,
    summary:
      "Knox Guard é a proteção de ativação da Samsung usada para bloquear aparelhos perdidos, roubados ou ainda vinculados a financiamento/contrato. Não é um recurso de diagnóstico e não deve ser removido por terceiros.",
    facts: [
      {
        id: "what",
        statement:
          "Knox Guard (antigo Samsung Device Protection/Knox Guard) é um serviço de proteção de dispositivo que pode impedir a ativação e o uso do aparelho, exibindo aviso de bloqueio na tela.",
        source: "Samsung Knox — Knox Guard",
      },
      {
        id: "why",
        statement:
          "Existe para dissuadir revenda não autorizada de aparelhos financiados, reduzir roubo/furto e permitir que operadoras e revendedores recuperem o controle de dispositivos inadimplentes ou perdidos.",
        source: "Samsung Knox — Knox Guard",
      },
      {
        id: "states",
        statement:
          "No Download Mode podem aparecer indicadores como KG STATE (Prenormal/Normal/Checking) e RMM STATE (Prenormal/Normal). Eles refletem o estado de proteção/gerenciamento, não são um defeito de hardware.",
        source: "Documentação Samsung de Download Mode / Knox",
      },
      {
        id: "removal",
        statement:
          "A remoção legítima é feita pelo provedor autorizado, operadora, administrador de MDM ou suporte Samsung, após comprovação de titularidade, quitação ou liberação contratual.",
        source: "Samsung Knox — Knox Guard / suporte oficial",
      },
      {
        id: "no-command",
        statement:
          "Não existe comando ADB, fastboot, Odin ou 'código de desbloqueio' legítimo que remova Knox Guard. Procedimentos de terceiros costumam ser fraude, malware ou dano permanente ao aparelho.",
        source: "Política de segurança Samsung / termos de garantia",
      },
      {
        id: "frp",
        statement:
          "Factory Reset Protection (FRP) é diferente de Knox Guard: protege contra configuração após reset não autorizado e exige a conta Google/prova de propriedade do titular anterior.",
        source: "Android Developers — Factory Reset Protection",
      },
      {
        id: "mdm",
        statement:
          "MDM/EMM corporativo instala perfis e políticas que podem bloquear Opções do desenvolvedor, instalação de apps e depuração USB. A liberação depende do administrador da organização.",
        source: "Android Enterprise — Device policy",
      },
      {
        id: "privacy",
        statement:
          "Acesso a dados de um aparelho pode envolver dados pessoais de terceiros. No Brasil, a LGPD (Lei 13.709/2018) exige base legal e finalidade definida para o tratamento.",
        source: "Lei 13.709/2018 (LGPD)",
      },
    ],
    lawfulRemoval: [
      "Contatar a operadora ou o revendedor que financiou/vendeu o aparelho e apresentar nota fiscal e comprovante de quitação.",
      "Abrir chamado no suporte oficial Samsung com o IMEI e a documentação de propriedade.",
      "Se o aparelho é corporativo, solicitar ao administrador de MDM/EMM a remoção da inscrição e das políticas.",
      "Se houve compra de aparelho usado, verificar antes da compra se há bloqueio e formalizar a transferência com o vendedor.",
    ],
    legalImplications: [
      "Contornar bloqueio de aparelho alheio pode configurar apropriação indébita, estelionato ou dano, dependendo do caso (Código Penal brasileiro, arts. 155, 171 e 266).",
      "A Lei 12.737/2012 (delitos informáticos) pune acesso não autorizado a dispositivo ou sistema informatizado.",
      "A remoção não autorizada pode violar contrato de financiamento, termos da Samsung e a garantia, além de gerar responsabilidade civil.",
      "Prestar serviço de 'desbloqueio' sem comprovar titularidade pode caracterizar fraude e lavagem de aparelhos de origem ilícita.",
    ],
    officialChannels: [
      "Suporte Samsung do país (com IMEI e documentação)",
      "Operadora/revendedor responsável pelo contrato",
      "Administrador de TI/MDM da organização",
      "Autoridade policial, em caso de aparelho roubado ou golpe",
    ],
    notProvided: [
      "Bypass de Knox Guard, FRP ou MDM",
      "Instalação de firmware não oficial para remover bloqueio",
      "Root, desbloqueio de bootloader ou alteração de partições sem autorização",
      "Ferramentas de terceiros que prometem 'desbloqueio universal'",
    ],
  };
}

/**
 * Comandos ADB de diagnóstico.
 *
 * `readOnly` sempre é devolvido. `stateChanging` só aparece com
 * `authorized === true` e `mode !== "read-only"`. Root/su, bypass e operações
 * destrutivas nunca são devolvidos como comandos executáveis.
 */
export function adbCommands(input: AdbCommandsInput): AdbCommandSet {
  const mode: AdbMode = input.mode ?? "diagnostics";
  const readOnly = [
    "adb devices -l",
    "adb shell getprop ro.product.manufacturer",
    "adb shell getprop ro.product.model",
    "adb shell getprop ro.build.version.release",
    "adb shell getprop ro.build.version.security_patch",
    "adb shell getprop ro.boot.verifiedbootstate",
    "adb shell getprop ro.boot.flash.locked",
    "adb shell getprop sys.boot_completed",
    "adb shell dumpsys battery",
    "adb shell dumpsys thermalservice",
    "adb shell dumpsys meminfo",
    "adb shell df -h",
    "adb shell pm list packages -3",
    "adb shell settings get global adb_enabled",
    "adb logcat -d -t 200",
    "adb bugreport ./bugreport.zip",
  ];

  const stateChanging = [
    "adb reboot",
    "adb reboot bootloader",
    "adb install -r ./diagnostico.apk",
    "adb shell pm grant com.exemplo.diagnostico android.permission.POST_NOTIFICATIONS",
    "adb shell dumpsys batterystats --reset",
    "adb shell am force-stop com.exemplo.diagnostico",
    "adb shell svc wifi enable",
    "adb shell svc wifi disable",
    "adb shell input keyevent KEYCODE_WAKEUP",
    "adb shell setprop log.tag.Diagnostico VERBOSE",
  ];

  const withheld = [
    "root/su: não é necessário para diagnóstico e exige build de depuração e consentimento específicos; não é oferecido aqui.",
    "desbloqueio de bootloader (fastboot flashing unlock): apaga dados, pode anular garantia e não será gerado por este módulo.",
    "bypass de Knox Guard, FRP ou MDM: não é oferecido em nenhuma hipótese; procure o canal oficial.",
    "pm clear, uninstall em massa e remoção de dados: podem apagar informações do usuário; não são retornados como comando.",
    "gravação de firmware/partição (fastboot flash, Odin, EDL): altera o dispositivo e exige pacote oficial + autorização.",
  ];

  const authorized = input.authorized === true;
  const notes: string[] = [
    "Comandos somente-leitura ainda acessam dados potencialmente pessoais; use apenas em dispositivo próprio ou com autorização documentada.",
    "Confirme o serial em `adb devices -l` antes de qualquer operação para não atingir o aparelho errado.",
  ];

  if (!authorized) {
    notes.push(
      "authorized=false: nenhum comando que altera estado foi retornado. Apenas leitura e explicação estão disponíveis.",
      "Para operações de escrita, forneça autorização verificável (propriedade, OS assinada ou ordem do administrador) e chame novamente com authorized=true.",
    );
  } else if (mode === "read-only") {
    notes.push(
      "mode=read-only: mesmo com authorized=true, comandos de alteração foram omitidos.",
    );
  } else {
    notes.push(
      "authorized=true: comandos de alteração foram incluídos. Faça backup, confine o escopo ao serial autorizado e esteja ciente de que reboot/install podem interromper serviços.",
    );
  }

  if (mode === "read-only") {
    return { authorized, mode, readOnly, stateChanging: [], withheld, notes };
  }

  return {
    authorized,
    mode,
    readOnly,
    stateChanging: authorized ? stateChanging : [],
    withheld,
    notes,
  };
}

/** Checklist de autorização antes de operar em aparelho de terceiros. */
export function authorizationChecklist(): ChecklistItem[] {
  return [
    {
      id: "ownership",
      question: "Você é o proprietário do aparelho ou tem autorização escrita do proprietário?",
      required: true,
      evidence: "Nota fiscal, contrato, termo de responsabilidade ou OS assinada.",
    },
    {
      id: "identity",
      question: "O dispositivo foi identificado de forma inequívoca?",
      required: true,
      evidence: "Serial, IMEI e VID:PID/porta registrados na OS.",
    },
    {
      id: "scope",
      question: "O escopo das operações está descrito (leitura, backup, reinstalação, reboot)?",
      required: true,
      evidence: "Lista de comandos/etapas aprovada pelo responsável.",
    },
    {
      id: "backup",
      question: "Há backup dos dados que possam ser perdidos?",
      required: true,
      evidence: "Backup verificado ou termo de ciência de perda de dados.",
    },
    {
      id: "privacy",
      question: "Dados pessoais serão tratados com base legal e finalidade definida?",
      required: true,
      evidence: "Registro LGPD: finalidade, base legal, retenção e descarte.",
    },
    {
      id: "corporate",
      question: "Se o aparelho é corporativo, o administrador de MDM autorizou?",
      required: false,
      evidence: "Ticket/aprovação do TI; políticas de MDM continuam válidas.",
    },
    {
      id: "revocation",
      question: "A autorização tem prazo e pode ser revogada?",
      required: true,
      evidence: "Data de expiração e contato do responsável.",
    },
    {
      id: "legal",
      question: "O serviço não envolve contornar Knox Guard, FRP ou MDM?",
      required: true,
      evidence: "Declaração de que o aparelho está liberado ou será encaminhado ao canal oficial.",
    },
  ];
}
