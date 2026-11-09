/**
 * Laboratórios guiados do módulo de redes.
 *
 * Cada laboratório entrega objetivo, topologia pronta, passos esperados e
 * um quiz com resposta comentada. Os IDs são usados pelo CLI:
 *   net labs
 *   net labs <id>
 */

import { Topology } from "./types";
import { buildScenario } from "./simulator";

export interface QuizQuestion {
  question: string;
  options: string[];
  /** Índice (0-based) da alternativa correta. */
  answer: number;
  explanation: string;
}

export interface Lab {
  id: string;
  title: string;
  objective: string;
  /** Topologia pronta; null em laboratórios puramente de cálculo. */
  topology: Topology | null;
  expectedSteps: string[];
  quiz: QuizQuestion[];
  /** Comandos do CLI que ajudam a resolver o laboratório. */
  commands: string[];
  hints: string[];
}

interface LabDefinition extends Omit<Lab, "topology"> {
  scenario?: string;
}

const definitions: LabDefinition[] = [
  {
    id: "switch",
    title: "Lab 1 — Switch único e aprendizado MAC",
    objective:
      "Observar o switch aprendendo endereços MAC, inundando broadcast/unknown unicast e passando a encaminhar known unicast na segunda transmissão.",
    scenario: "single-switch",
    expectedSteps: [
      "h1 resolve o MAC de h2 por ARP: o request é broadcast e o switch inunda as portas 2, 3 e 4.",
      "O switch aprende h1 na porta 1 e h2 na porta 2 ao ver as respostas ARP.",
      "O pacote IPv4 de h1 para h2 é encaminhado somente pela porta 2 (known unicast).",
      "Uma tabela MAC vazia (após aging ou flush) volta a causar flooding para o mesmo destino.",
      "O TTL não muda: o switch não roteia, apenas comuta.",
    ],
    quiz: [
      {
        question: "O que o switch faz com um unicast cujo MAC de destino ainda não conhece?",
        options: [
          "Descarta o frame",
          "Inunda todas as portas da mesma VLAN, exceto a de ingresso",
          "Envia para o gateway padrão",
          "Decrementa o TTL e encaminha",
        ],
        answer: 1,
        explanation:
          "Unknown unicast é inundado dentro do domínio de broadcast (VLAN); a resposta do destino ensina o switch.",
      },
      {
        question: "Qual comando do simulador permite ver o flooding e o aprendizado?",
        options: [
          "net sim single-switch h1 h2",
          "net subnet 192.168.10.0/24",
          "net vlsm 192.168.10.0/24 10,20",
          "net route 192.168.10.20 192.168.10.0/24",
        ],
        answer: 0,
        explanation: "O subcomando sim executa o pacote e narra cada decisão L2.",
      },
    ],
    commands: [
      "net sim single-switch h1 h2",
      "net sim single-switch h1 h2   (repita para ver known unicast)",
    ],
    hints: [
      "Compare a primeira e a segunda execução: o ARP continua broadcast, mas o IPv4 fica known unicast.",
      "O campo 'aprendizado' do trace indica se uma entrada nova entrou na tabela.",
    ],
  },
  {
    id: "vlans",
    title: "Lab 2 — VLANs e isolamento de broadcast",
    objective:
      "Comprovar que duas VLANs no mesmo switch são domínios de broadcast distintos, mesmo usando o mesmo espaço de endereçamento IP.",
    scenario: "vlans",
    expectedSteps: [
      "h1 (VLAN 10) e h2 (VLAN 10) se comunicam normalmente.",
      "O ARP request de h1 para h3 (VLAN 20) é inundado somente nas portas da VLAN 10.",
      "h3 nunca recebe o request; não há ARP reply e o pacote é descartado.",
      "Um frame marcado 802.1Q chegando em porta access é descartado.",
      "Para cruzar VLANs é necessário um roteador (router-on-a-stick) ou um L3 switch.",
    ],
    quiz: [
      {
        question: "Por que h1 não alcança h3, apesar de ambos estarem em 10.0.0.0/24?",
        options: [
          "Porque o TTL expira no switch",
          "Porque o switch separa as VLANs em domínios de broadcast distintos",
          "Porque falta uma rota default no host",
          "Porque o MAC de h3 é multicast",
        ],
        answer: 1,
        explanation:
          "VLANs isolam o domínio de broadcast; sem roteamento entre VLANs o ARP nunca chega ao outro lado.",
      },
      {
        question: "O que acontece com um frame com tag 802.1Q recebido em uma porta access?",
        options: [
          "É aceito na VLAN nativa",
          "É convertido em trunk automaticamente",
          "É descartado",
          "É enviado ao roteador",
        ],
        answer: 2,
        explanation:
          "Porta access espera frames sem tag; receber frame marcado é uma inconsistência de configuração e o switch descarta.",
      },
    ],
    commands: ["net sim vlans h1 h2", "net sim vlans h1 h3"],
    hints: [
      "No trace, observe a linha 'alcança N vizinho(s)': a VLAN 20 não aparece.",
      "O switch não é um roteador: ele não encaminha entre VLANs.",
    ],
  },
  {
    id: "inter-vlan",
    title: "Lab 3 — Roteamento inter-VLAN (router-on-a-stick)",
    objective:
      "Seguir um pacote entre VLANs 10 e 20 usando um roteador com subinterfaces 802.1Q em um único trunk.",
    scenario: "router-on-a-stick",
    expectedSteps: [
      "h1 envia ARP para o gateway 192.168.10.1 e recebe o MAC da subinterface gi0/0.10.",
      "O frame sai de h1 sem tag, entra na porta access VLAN 10 e sai pelo trunk com tag 802.1Q 10.",
      "O roteador desmarca o frame na subinterface gi0/0.10 e consulta a tabela de rotas.",
      "A rota connected 192.168.20.0/24 aponta para gi0/0.20; o roteador faz ARP de h3 na VLAN 20.",
      "O frame é marcado com VLAN 20 no trunk, desmarcado na porta access e entregue a h3.",
      "O TTL é decrementado em 1 pelo roteador; o switch não altera o TTL.",
    ],
    quiz: [
      {
        question: "Onde o frame recebe a tag 802.1Q no caminho h1 -> h3?",
        options: [
          "Na porta access de h1",
          "Na saída do trunk em direção ao roteador",
          "Na subinterface gi0/0.20, antes de voltar ao switch",
          "No host h3",
        ],
        answer: 1,
        explanation:
          "A tag é adicionada pelo switch ao sair por um trunk e removida ao entrar em uma porta access.",
      },
      {
        question: "Quantas vezes o TTL diminui no caminho h1 -> h3?",
        options: ["Zero, o switch cuida disso", "Uma, no roteador", "Duas, uma por VLAN", "Depende do ARP"],
        answer: 1,
        explanation: "Só o roteador decrementa o TTL; switches L2 não alteram o cabeçalho IP.",
      },
    ],
    commands: [
      "net sim router-on-a-stick h1 h3",
      "net subnet 192.168.10.0/24",
      "net subnet 192.168.20.0/24",
    ],
    hints: [
      "Procure no trace os passos 'trunk 5 recebeu frame marcado' e 'porta access ... -> VLAN'.",
      "O gateway de cada VLAN é a subinterface com o mesmo VLAN ID.",
    ],
  },
  {
    id: "static-routes",
    title: "Lab 4 — Rotas estáticas entre dois roteadores",
    objective:
      "Verificar longest-prefix match, próximo salto, ARP por salto e decremento de TTL em um caminho com dois roteadores.",
    scenario: "static-routes",
    expectedSteps: [
      "h1 usa o gateway 192.168.1.1 (r1) e resolve ARP para ele.",
      "r1 consulta a tabela: 192.168.2.0/24 via 10.0.0.2; o link r1-r2 é 10.0.0.0/30.",
      "r1 decrementa o TTL de 64 para 63 e resolve ARP de 10.0.0.2.",
      "r2 recebe, consulta a rota connected 192.168.2.0/24, decrementa o TTL para 62 e entrega a h2.",
      "O retorno de h2 para h1 usa a rota estática 192.168.1.0/24 via 10.0.0.1.",
    ],
    quiz: [
      {
        question: "Por que o link entre r1 e r2 usa /30?",
        options: [
          "Para ter 254 hosts utilizáveis",
          "Porque /30 fornece 2 endereços utilizáveis, suficientes para um link ponto a ponto",
          "Porque /30 é obrigatório em roteadores",
          "Para permitir broadcast entre as LANs",
        ],
        answer: 1,
        explanation: "Um /30 tem 4 endereços: rede, broadcast e dois hosts — ideal para links ponto a ponto.",
      },
      {
        question: "Se r1 não tivesse a rota 192.168.2.0/24 e nem default, o que aconteceria?",
        options: [
          "O switch aprenderia a rota",
          "O pacote seria entregue por flooding",
          "r1 descartaria e poderia gerar ICMP destination unreachable",
          "O TTL aumentaria",
        ],
        answer: 2,
        explanation: "Sem rota, o roteador descarta o pacote; o ICMP unreachable avisa a origem.",
      },
    ],
    commands: [
      "net sim static-routes h1 h2",
      "net route 192.168.2.10 192.168.0.0/16 192.168.2.0/24 0.0.0.0/0",
    ],
    hints: [
      "O trace mostra 'rota ... via ...' em cada roteador.",
      "Observe o TTL nos passos L3: 64 -> 63 -> 62.",
    ],
  },
  {
    id: "summarize",
    title: "Lab 5 — Sumarização de rotas",
    objective:
      "Unir rotas contíguas em um único anúncio CIDR, reduzindo o tamanho da tabela sem mudar o conjunto de destinos cobertos.",
    scenario: "static-routes",
    expectedSteps: [
      "192.168.0.0/24 e 192.168.1.0/24 são contíguas e alinhadas: somam 192.168.0.0/23.",
      "192.168.0.0/25 e 192.168.0.128/25 somam 192.168.0.0/24.",
      "Blocos não contíguos, como 10.0.0.0/24 e 10.0.2.0/24, não podem virar um único /23 sem cobrir 10.0.1.0/24.",
      "A soma só é válida quando todos os endereços do bloco resultante pertencem ao conjunto original.",
    ],
    quiz: [
      {
        question: "Qual é a melhor sumarização de 172.16.0.0/24, 172.16.1.0/24, 172.16.2.0/24 e 172.16.3.0/24?",
        options: ["172.16.0.0/24", "172.16.0.0/22", "172.16.0.0/23", "172.16.0.0/21"],
        answer: 1,
        explanation: "Quatro /24 alinhados a partir de 172.16.0.0 formam um /22 (2^(24-22) = 4 blocos).",
      },
      {
        question: "É correto sumarizar 10.0.0.0/24 e 10.0.2.0/24 como 10.0.0.0/23?",
        options: [
          "Sim, porque ambos começam com 10.0.",
          "Sim, porque /23 é sempre a soma de dois /24.",
          "Não, pois 10.0.1.0/24 ficaria indevidamente coberto.",
          "Não, porque /24 não pode ser sumarizado.",
        ],
        answer: 2,
        explanation:
          "10.0.2.0 não está dentro de 10.0.0.0/23 (que cobre 10.0.0.0–10.0.1.255); a soma mudaria o alcance.",
      },
    ],
    commands: [
      "net route 172.16.2.10 172.16.0.0/22 172.16.0.0/23 0.0.0.0/0",
      "net subnet 172.16.0.0/22",
    ],
    hints: [
      "Use a calculadora: a soma precisa começar em um múltiplo do tamanho do bloco.",
      "O CLI `route` demonstra por que o prefixo mais longo vence.",
    ],
  },
  {
    id: "vlsm",
    title: "Lab 6 — Cálculo de sub-redes VLSM",
    objective:
      "Dividir um bloco em sub-redes de tamanhos diferentes, alocando do maior para o menor para evitar fragmentação do espaço.",
    expectedSteps: [
      "Some 2 ao número de hosts pedido (rede + broadcast) e arredonde para a potência de dois.",
      "50 hosts -> 64 endereços -> /26 (62 utilizáveis).",
      "20 hosts -> 32 endereços -> /27 (30 utilizáveis).",
      "10 hosts -> 16 endereços -> /28 (14 utilizáveis).",
      "5 hosts -> 8 endereços -> /29 (6 utilizáveis).",
      "No /24 192.168.0.0/24: .0/26, .64/27, .96/28 e .112/29; os blocos restantes ficam livres para crescimento.",
    ],
    quiz: [
      {
        question: "Uma sub-rede precisa de 30 hosts. Qual é o menor bloco CIDR clássico que atende?",
        options: ["/26", "/27", "/28", "/29"],
        answer: 1,
        explanation: "Um /27 tem 32 endereços e 30 utilizáveis, exatamente o necessário.",
      },
      {
        question: "Por que o VLSM aloca primeiro os maiores blocos?",
        options: [
          "Para deixar os menores mais rápidos",
          "Para garantir alinhamento e evitar fragmentos inutilizáveis",
          "Porque o protocolo IP exige /26 antes de /27",
          "Para reduzir o TTL",
        ],
        answer: 1,
        explanation:
          "Alocar do maior para o menor preserva blocos contíguos e evita que um bloco grande não caiba por causa de um pequeno mal posicionado.",
      },
    ],
    commands: ["net vlsm 192.168.0.0/24 50,20,10,5"],
    hints: [
      "O campo 'desperdício' mostra quantos endereços utilizáveis sobraram em cada bloco.",
      "Endereço de rede e broadcast nunca são atribuídos a hosts.",
    ],
  },
];

/** Lista completa com topologias instanciadas. */
export const LABS: Lab[] = definitions.map((definition) => ({
  ...definition,
  topology: definition.scenario ? buildScenario(definition.scenario) : null,
}));

/** Busca um laboratório por ID, com topologia nova (não compartilhada). */
export function getLab(id: string): Lab | undefined {
  const definition = definitions.find((item) => item.id === id);
  if (!definition) return undefined;
  return {
    ...definition,
    topology: definition.scenario ? buildScenario(definition.scenario) : null,
  };
}

export function listLabs(): Array<{ id: string; title: string; objective: string }> {
  return definitions.map((item) => ({
    id: item.id,
    title: item.title,
    objective: item.objective,
  }));
}

/** Resposta correta já formatada (A, B, C...). */
export function answerLabel(question: QuizQuestion): string {
  return String.fromCharCode(65 + question.answer);
}
