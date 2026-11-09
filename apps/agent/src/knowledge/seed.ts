/**
 * Seed offline de CVEs reais e curados.
 *
 * Serve como fallback quando o NVD não está acessível e como base
 * determinística para testes e para o comando `build`. Cada registro traz
 * CVSS, CWE, produtos e uma mitigação defensiva. Nenhum exploit/PoC.
 */

import type { CveProduct, CveRecord, CveReference } from "./types";
import { CWE_DESCRIPTIONS } from "./build";

export const SEED_CWE_DESCRIPTIONS: Record<string, string> = CWE_DESCRIPTIONS;

interface SeedInput {
  id: string;
  published: string;
  description: string;
  score: number;
  severity: string;
  vector: string;
  cwes: string[];
  products: CveProduct[];
  mitigation: string;
  references?: CveReference[];
}

function product(vendor: string, name: string, versions: string[]): CveProduct {
  return { vendor, product: name, versions };
}

function reference(url: string, tags: string[] = ["Vendor Advisory"]): CveReference {
  return { url, tags };
}

function makeCve(input: SeedInput): CveRecord {
  return {
    id: input.id,
    source: "seed",
    published: input.published,
    modified: input.published,
    description: input.description,
    cvss: {
      version: "3.1",
      score: input.score,
      severity: input.severity,
      vector: input.vector,
    },
    cwes: input.cwes,
    products: input.products,
    references: [
      reference(`https://nvd.nist.gov/vuln/detail/${input.id}`, ["NVD", "Vulnerability Database"]),
      ...(input.references ?? []),
    ],
    weaknesses: input.cwes,
    mitigation: input.mitigation,
  };
}

const AV_NETWORK = "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H";
const AV_LOCAL = "CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H";
const AV_CHANGED = "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H";

/** 30 CVEs públicos usados como fallback offline. */
export const SEED_CVES: CveRecord[] = [
  makeCve({
    id: "CVE-2021-44228",
    published: "2021-12-10",
    description:
      "O Apache Log4j 2 não neutraliza adequadamente expressões de lookup em mensagens de log, permitindo que entrada controlada pelo atacante seja interpretada pelo componente de logging.",
    score: 10.0,
    severity: "CRITICAL",
    vector: AV_CHANGED,
    cwes: ["CWE-502", "CWE-917"],
    products: [product("apache", "log4j", ["2.0-beta9", "2.14.1"])],
    mitigation:
      "Atualize o Log4j 2 para 2.17.1 ou superior; remova o JndiLookup do classpath em versões antigas; bloqueie conexões de saída não necessárias e monitore expressões de lookup nos logs.",
    references: [reference("https://logging.apache.org/log4j/2.x/security.html")],
  }),
  makeCve({
    id: "CVE-2014-0160",
    published: "2014-04-07",
    description:
      "O OpenSSL não valida corretamente o tamanho de uma requisição de heartbeat TLS, permitindo leitura de memória além do buffer e exposição de dados sensíveis do processo.",
    score: 7.5,
    severity: "HIGH",
    vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N",
    cwes: ["CWE-125"],
    products: [product("openssl", "openssl", ["1.0.1", "1.0.1f"])],
    mitigation:
      "Atualize o OpenSSL para 1.0.1g ou superior; revogue e reemita certificados e chaves que possam ter sido expostos; reinicie serviços que usam a biblioteca e monitore acessos anômalos.",
    references: [reference("https://www.openssl.org/news/secadv/20140407.txt")],
  }),
  makeCve({
    id: "CVE-2017-0144",
    published: "2017-03-16",
    description:
      "O protocolo SMBv1 do Microsoft Windows não valida adequadamente pacotes especiais, permitindo corrupção de memória e execução remota de código em sistemas vulneráveis.",
    score: 8.1,
    severity: "HIGH",
    vector: "CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H",
    cwes: ["CWE-20"],
    products: [product("microsoft", "windows_smbv1", ["Vista SP2", "7 SP1", "Server 2008 R2 SP1"])],
    mitigation:
      "Aplique a atualização MS17-010; desative o SMBv1; bloqueie as portas 445 e 139 na borda; segmente a rede e monitore tentativas de conexão SMB incomuns.",
    references: [reference("https://msrc.microsoft.com/update-guide/vulnerability/CVE-2017-0144")],
  }),
  makeCve({
    id: "CVE-2021-45046",
    published: "2021-12-14",
    description:
      "A correção inicial do Apache Log4j 2 para CVE-2021-44228 era incompleta e ainda permitia que determinadas expressões de lookup fossem processadas em condições específicas.",
    score: 9.0,
    severity: "CRITICAL",
    vector: AV_CHANGED,
    cwes: ["CWE-502", "CWE-917"],
    products: [product("apache", "log4j", ["2.0-beta9", "2.15.0"])],
    mitigation:
      "Atualize para Log4j 2.17.1 ou superior; remova o JndiLookup em instalações antigas; restrinja saída de rede e monitore padrões de lookup em mensagens de log.",
    references: [reference("https://logging.apache.org/log4j/2.x/security.html")],
  }),
  makeCve({
    id: "CVE-2022-22965",
    published: "2022-04-01",
    description:
      "O Spring Framework permite que data binding alcance propriedades de classloader em determinadas configurações, resultando em injeção de código em aplicações executadas em JDK 9 ou superior.",
    score: 9.8,
    severity: "CRITICAL",
    vector: AV_NETWORK,
    cwes: ["CWE-94"],
    products: [product("vmware", "spring_framework", ["5.3.0-5.3.17", "5.2.0-5.2.19"])],
    mitigation:
      "Atualize o Spring Framework para 5.3.18 ou 5.2.20; quando não for possível, aplique as mitigações oficiais de data binding e restrinja o acesso ao serviço.",
    references: [reference("https://spring.io/security/cve-2022-22965")],
  }),
  makeCve({
    id: "CVE-2021-34527",
    published: "2021-07-01",
    description:
      "O serviço Windows Print Spooler não restringe adequadamente operações de instalação de driver, permitindo que um usuário autenticado obtenha privilégios elevados no sistema.",
    score: 8.8,
    severity: "HIGH",
    vector: "CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H",
    cwes: ["CWE-269"],
    products: [product("microsoft", "windows_print_spooler", ["Windows 7", "Windows 10", "Server 2019"])],
    mitigation:
      "Aplique as atualizações do fornecedor; desative o Print Spooler em servidores que não imprimem; restrinja RPC e instalação de drivers por política; monitore criação incomum de arquivos de driver.",
    references: [reference("https://msrc.microsoft.com/update-guide/vulnerability/CVE-2021-34527")],
  }),
  makeCve({
    id: "CVE-2023-4863",
    published: "2023-09-12",
    description:
      "A biblioteca libwebp não valida corretamente limites ao decodificar imagens WebP, permitindo escrita fora dos limites do buffer durante o processamento de conteúdo não confiável.",
    score: 8.8,
    severity: "HIGH",
    vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:H",
    cwes: ["CWE-787"],
    products: [
      product("webmproject", "libwebp", ["<=1.3.1"]),
      product("google", "chrome", ["<117.0.5938.62"]),
    ],
    mitigation:
      "Atualize libwebp, navegadores e aplicações que decodificam WebP; recompile componentes que embutem a biblioteca; monitore quedas e corrupção de processos ao processar imagens.",
    references: [reference("https://chromereleases.googleblog.com/2023/09/stable-channel-update-for-desktop_11.html")],
  }),
  makeCve({
    id: "CVE-2021-3156",
    published: "2021-01-26",
    description:
      "O sudo contém um erro de off-by-one ao processar argumentos de linha de comando, permitindo que um usuário local sem privilégios acione corrupção de memória e eleve privilégios.",
    score: 7.8,
    severity: "HIGH",
    vector: AV_LOCAL,
    cwes: ["CWE-193"],
    products: [product("sudo", "sudo", ["1.8.2", "1.9.5p1"])],
    mitigation:
      "Atualize o sudo para 1.9.5p2 ou superior; restrinja acesso local e contas de serviço; monitore execuções incomuns do sudo e mudanças de privilégio.",
    references: [reference("https://www.sudo.ws/security/advisories/baron_samedit/")],
  }),
  makeCve({
    id: "CVE-2022-0847",
    published: "2022-03-10",
    description:
      "O kernel Linux não inicializa corretamente flags de buffers de pipe, permitindo que um usuário local sobrescreva arquivos somente leitura em cache de página e eleve privilégios.",
    score: 7.8,
    severity: "HIGH",
    vector: AV_LOCAL,
    cwes: ["CWE-665"],
    products: [product("linux", "linux_kernel", ["5.8", "5.16.11"])],
    mitigation:
      "Atualize o kernel para uma versão corrigida; reinicie os sistemas afetados; restrinja acesso local e monitore alterações inesperadas em arquivos do sistema.",
    references: [reference("https://dirtypipe.cm4all.com/")],
  }),
  makeCve({
    id: "CVE-2019-0708",
    published: "2019-05-14",
    description:
      "O Remote Desktop Services do Windows não valida adequadamente requisições durante a negociação de conexão, permitindo execução remota de código sem autenticação prévia.",
    score: 9.8,
    severity: "CRITICAL",
    vector: AV_NETWORK,
    cwes: ["CWE-416"],
    products: [product("microsoft", "windows_remote_desktop_services", ["Windows 7", "Server 2008 R2"])],
    mitigation:
      "Aplique as atualizações do fornecedor; desative RDP quando não for necessário; habilite Network Level Authentication; restrinja a porta 3389 e monitore tentativas de conexão.",
    references: [reference("https://msrc.microsoft.com/update-guide/vulnerability/CVE-2019-0708")],
  }),
  makeCve({
    id: "CVE-2020-1472",
    published: "2020-08-17",
    description:
      "O protocolo Netlogon do Windows usa um valor criptográfico insuficientemente aleatório na autenticação, permitindo que um atacante de rede se passe por um controlador de domínio.",
    score: 10.0,
    severity: "CRITICAL",
    vector: AV_CHANGED,
    cwes: ["CWE-330", "CWE-287"],
    products: [product("microsoft", "windows_netlogon", ["Server 2008 R2", "Server 2019"])],
    mitigation:
      "Aplique as atualizações de segurança do Netlogon; habilite enforcement mode após validar a compatibilidade; restrinja comunicação com controladores de domínio e monitore eventos de autenticação anômalos.",
    references: [reference("https://msrc.microsoft.com/update-guide/vulnerability/CVE-2020-1472")],
  }),
  makeCve({
    id: "CVE-2017-5638",
    published: "2017-03-10",
    description:
      "O Apache Struts 2 processa de forma insegura o cabeçalho Content-Type em determinadas requisições, permitindo que uma expressão controlada pelo atacante seja avaliada pelo servidor.",
    score: 10.0,
    severity: "CRITICAL",
    vector: AV_CHANGED,
    cwes: ["CWE-20", "CWE-917"],
    products: [product("apache", "struts", ["2.3.5", "2.3.31", "2.5", "2.5.10"])],
    mitigation:
      "Atualize o Struts para 2.3.32 ou 2.5.10.1; aplique validação de Content-Type no proxy reverso; monitore erros de expressão e requisições com cabeçalhos anormais.",
    references: [reference("https://cwiki.apache.org/confluence/display/WW/S2-045")],
  }),
  makeCve({
    id: "CVE-2019-11043",
    published: "2019-10-28",
    description:
      "O PHP-FPM com determinadas configurações de nginx não trata corretamente caminhos e variáveis de ambiente, permitindo que uma requisição manipulada resulte em execução de código.",
    score: 9.8,
    severity: "CRITICAL",
    vector: AV_NETWORK,
    cwes: ["CWE-20"],
    products: [product("php", "php-fpm", ["7.1.x", "7.2.x", "7.3.x"])],
    mitigation:
      "Atualize o PHP para versões corrigidas; revise a configuração de fastcgi_split_path_info e try_files; restrinja acesso ao PHP-FPM e monitore erros de roteamento.",
    references: [reference("https://bugs.php.net/bug.php?id=78599")],
  }),
  makeCve({
    id: "CVE-2020-1938",
    published: "2020-02-20",
    description:
      "O conector AJP do Apache Tomcat permite acesso a recursos internos sem autenticação adequada, possibilitando leitura de arquivos e, em certas configurações, execução de código.",
    score: 9.8,
    severity: "CRITICAL",
    vector: AV_NETWORK,
    cwes: ["CWE-269"],
    products: [product("apache", "tomcat", ["6", "7", "8", "9"])],
    mitigation:
      "Atualize o Tomcat; desative o conector AJP quando não for usado ou exija segredo forte e restrinja a porta 8009 a proxies confiáveis.",
    references: [reference("https://tomcat.apache.org/security-9.html")],
  }),
  makeCve({
    id: "CVE-2021-41773",
    published: "2021-10-05",
    description:
      "O Apache HTTP Server 2.4.49 não normaliza corretamente caminhos em requisições, permitindo path traversal e acesso a arquivos fora do diretório documentado.",
    score: 7.5,
    severity: "HIGH",
    vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N",
    cwes: ["CWE-22"],
    products: [product("apache", "http_server", ["2.4.49"])],
    mitigation:
      "Atualize para 2.4.51 ou superior; desative a diretiva `Require all granted` em diretórios sem necessidade; monitore sequências de travessia e respostas 403/404 anômalas.",
    references: [reference("https://httpd.apache.org/security/vulnerabilities_24.html")],
  }),
  makeCve({
    id: "CVE-2021-42013",
    published: "2021-10-07",
    description:
      "A correção do Apache HTTP Server para CVE-2021-41773 era incompleta e ainda permitia path traversal e execução remota de código em configurações específicas.",
    score: 9.8,
    severity: "CRITICAL",
    vector: AV_NETWORK,
    cwes: ["CWE-22"],
    products: [product("apache", "http_server", ["2.4.50"])],
    mitigation:
      "Atualize para 2.4.51 ou superior; revise módulos CGI habilitados; restrinja acesso a diretórios e monitore requisições com caminhos codificados de forma anômala.",
    references: [reference("https://httpd.apache.org/security/vulnerabilities_24.html")],
  }),
  makeCve({
    id: "CVE-2022-30190",
    published: "2022-05-30",
    description:
      "O Microsoft Windows Support Diagnostic Tool processa URIs de forma insegura quando acionado por um documento, permitindo execução de código no contexto do usuário.",
    score: 7.8,
    severity: "HIGH",
    vector: "CVSS:3.1/AV:L/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:H",
    cwes: ["CWE-94"],
    products: [product("microsoft", "windows_msdt", ["Windows 10", "Windows 11", "Server 2019"])],
    mitigation:
      "Aplique as atualizações do fornecedor; desative o protocolo ms-msdt por política; bloqueie a execução de documentos não confiáveis e monitore processos filhos do Word.",
    references: [reference("https://msrc.microsoft.com/update-guide/vulnerability/CVE-2022-30190")],
  }),
  makeCve({
    id: "CVE-2023-23397",
    published: "2023-03-14",
    description:
      "O Microsoft Outlook não protege adequadamente determinadas propriedades de mensagens, permitindo que um atacante force autenticação NTLM contra um servidor controlado por ele.",
    score: 9.8,
    severity: "CRITICAL",
    vector: AV_NETWORK,
    cwes: ["CWE-294"],
    products: [product("microsoft", "outlook", ["2013", "2016", "2019", "365"])],
    mitigation:
      "Aplique as atualizações do Outlook; bloqueie saída SMB e NTLM para destinos externos; habilite proteção contra relay e monitore autenticações NTLM incomuns.",
    references: [reference("https://msrc.microsoft.com/update-guide/vulnerability/CVE-2023-23397")],
  }),
  makeCve({
    id: "CVE-2024-3094",
    published: "2024-03-29",
    description:
      "O XZ Utils 5.6.0 e 5.6.1 contém código malicioso inserido na cadeia de suprimentos que pode alterar o comportamento da autenticação em builds específicas.",
    score: 10.0,
    severity: "CRITICAL",
    vector: AV_CHANGED,
    cwes: ["CWE-506"],
    products: [product("tukaani", "xz_utils", ["5.6.0", "5.6.1"])],
    mitigation:
      "Faça downgrade para XZ Utils 5.4.6 ou uma versão confiável; verifique hashes e assinaturas de artefatos; audite dependências e reconstrua pacotes a partir de fontes verificadas.",
    references: [reference("https://www.openwall.com/lists/oss-security/2024/03/29/4")],
  }),
  makeCve({
    id: "CVE-2023-44487",
    published: "2023-10-10",
    description:
      "Implementações de HTTP/2 não limitam adequadamente a criação e o cancelamento de streams, permitindo que um cliente consuma recursos do servidor e cause negação de serviço.",
    score: 7.5,
    severity: "HIGH",
    vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H",
    cwes: ["CWE-400"],
    products: [
      product("ietf", "http2", ["implementações afetadas"]),
      product("nginx", "nginx", ["1.25.x"]),
      product("apache", "http_server", ["2.4.55"]),
    ],
    mitigation:
      "Atualize servidores e proxies HTTP/2; limite o número de streams simultâneos e a taxa de RST_STREAM; monitore picos de conexões e latência.",
    references: [reference("https://www.cve.org/CVERecord?id=CVE-2023-44487", ["CVE Record"])],
  }),
  makeCve({
    id: "CVE-2018-7600",
    published: "2018-03-29",
    description:
      "O Drupal não valida adequadamente determinados parâmetros de formulários, permitindo que entrada controlada pelo atacante seja processada e resulte em execução remota de código.",
    score: 9.8,
    severity: "CRITICAL",
    vector: AV_NETWORK,
    cwes: ["CWE-20"],
    products: [product("drupal", "drupal", ["7.x", "8.x"])],
    mitigation:
      "Atualize o Drupal para versões corrigidas; aplique o patch oficial quando a atualização imediata não for possível; restrinja acesso administrativo e monitore erros de formulário.",
    references: [reference("https://www.drupal.org/sa-core-2018-002")],
  }),
  makeCve({
    id: "CVE-2021-26855",
    published: "2021-03-02",
    description:
      "O Microsoft Exchange Server não valida adequadamente requisições, permitindo server-side request forgery e acesso não autorizado a serviços internos.",
    score: 9.8,
    severity: "CRITICAL",
    vector: AV_NETWORK,
    cwes: ["CWE-918"],
    products: [product("microsoft", "exchange_server", ["2013", "2016", "2019"])],
    mitigation:
      "Aplique as atualizações do Exchange; restrinja acesso externo ao OWA e ECP; segmente o servidor e monitore requisições internas anômalas.",
    references: [reference("https://msrc.microsoft.com/update-guide/vulnerability/CVE-2021-26855")],
  }),
  makeCve({
    id: "CVE-2022-26134",
    published: "2022-06-02",
    description:
      "O Atlassian Confluence Server e Data Center permite injeção de expressão OGNL em requisições não autenticadas, resultando em execução remota de código.",
    score: 9.8,
    severity: "CRITICAL",
    vector: AV_NETWORK,
    cwes: ["CWE-94"],
    products: [product("atlassian", "confluence_server", ["7.4.0", "7.18.1"])],
    mitigation:
      "Atualize o Confluence para versões corrigidas; restrinja acesso à internet; monitore erros de expressão e requisições anormais; invalide sessões administrativas após a correção.",
    references: [reference("https://confluence.atlassian.com/doc/confluence-security-advisory-2022-06-02-1130377079.html")],
  }),
  makeCve({
    id: "CVE-2020-0796",
    published: "2020-03-12",
    description:
      "O driver SMBv3 do Windows não valida adequadamente pacotes comprimidos, permitindo corrupção de memória e execução remota de código em sistemas vulneráveis.",
    score: 10.0,
    severity: "CRITICAL",
    vector: AV_CHANGED,
    cwes: ["CWE-119"],
    products: [product("microsoft", "windows_smbv3", ["Windows 10 1903", "Windows 10 1909"])],
    mitigation:
      "Aplique a atualização do fornecedor; desative a compressão SMBv3 por política; bloqueie a porta 445 na borda e monitore tráfego SMB incomum.",
    references: [reference("https://msrc.microsoft.com/update-guide/vulnerability/CVE-2020-0796")],
  }),
  makeCve({
    id: "CVE-2023-34362",
    published: "2023-06-02",
    description:
      "O Progress MOVEit Transfer não neutraliza adequadamente entrada em consultas SQL, permitindo injeção e acesso não autorizado a dados do ambiente.",
    score: 9.8,
    severity: "CRITICAL",
    vector: AV_NETWORK,
    cwes: ["CWE-89"],
    products: [product("progress", "moveit_transfer", ["2021.0", "2023.0"])],
    mitigation:
      "Aplique o patch do fornecedor; use consultas parametrizadas; restrinja acesso ao serviço; monitore consultas anômalas e acessos a dados fora do padrão.",
    references: [reference("https://www.progress.com/security/moveit-transfer-and-moveit-cloud-vulnerability")],
  }),
  makeCve({
    id: "CVE-2024-3400",
    published: "2024-04-12",
    description:
      "O GlobalProtect do Palo Alto Networks PAN-OS não neutraliza adequadamente entrada em determinados comandos, permitindo injeção de comando não autenticada.",
    score: 10.0,
    severity: "CRITICAL",
    vector: AV_CHANGED,
    cwes: ["CWE-77"],
    products: [product("paloaltonetworks", "pan-os", ["10.2", "11.0", "11.1"])],
    mitigation:
      "Atualize o PAN-OS para versões corrigidas; aplique as mitigações temporárias do fornecedor; restrinja o portal GlobalProtect e monitore comandos e processos anômalos.",
    references: [reference("https://security.paloaltonetworks.com/CVE-2024-3400")],
  }),
  makeCve({
    id: "CVE-2021-34473",
    published: "2021-07-13",
    description:
      "O Microsoft Exchange Server não valida adequadamente determinadas requisições, permitindo bypass de autenticação e acesso a recursos internos em combinação com outras falhas.",
    score: 9.8,
    severity: "CRITICAL",
    vector: AV_NETWORK,
    cwes: ["CWE-918"],
    products: [product("microsoft", "exchange_server", ["2013", "2016", "2019"])],
    mitigation:
      "Aplique todas as atualizações do Exchange; restrinja acesso externo a endpoints administrativos; segmente o servidor e monitore autenticações e requisições internas incomuns.",
    references: [reference("https://msrc.microsoft.com/update-guide/vulnerability/CVE-2021-34473")],
  }),
  makeCve({
    id: "CVE-2019-11510",
    published: "2019-04-24",
    description:
      "O Pulse Connect Secure permite leitura de arquivos arbitrários por meio de requisições não autenticadas, podendo expor credenciais e configurações sensíveis.",
    score: 10.0,
    severity: "CRITICAL",
    vector: AV_CHANGED,
    cwes: ["CWE-22"],
    products: [product("pulsesecure", "pulse_connect_secure", ["8.1R1", "9.1R8"])],
    mitigation:
      "Atualize o Pulse Connect Secure; troque credenciais e certificados que possam ter sido expostos; restrinja acesso administrativo e monitore leitura de arquivos incomum.",
    references: [reference("https://kb.pulsesecure.net/articles/Pulse_Security_Advisories/SA44101/")],
  }),
  makeCve({
    id: "CVE-2019-19781",
    published: "2019-12-17",
    description:
      "O Citrix Application Delivery Controller não normaliza corretamente caminhos, permitindo path traversal e execução de código em configurações vulneráveis.",
    score: 9.8,
    severity: "CRITICAL",
    vector: AV_NETWORK,
    cwes: ["CWE-22"],
    products: [product("citrix", "application_delivery_controller", ["10.5", "11.1", "12.0", "12.1", "13.0"])],
    mitigation:
      "Atualize o Citrix ADC; aplique as mitigações temporárias do fornecedor; restrinja acesso à interface de gerenciamento e monitore caminhos anômalos.",
    references: [reference("https://support.citrix.com/article/CTX267027")],
  }),
  makeCve({
    id: "CVE-2021-21972",
    published: "2021-02-24",
    description:
      "O VMware vCenter Server não valida adequadamente caminhos em um endpoint, permitindo que um atacante remoto não autenticado envie arquivos e execute código.",
    score: 9.8,
    severity: "CRITICAL",
    vector: AV_NETWORK,
    cwes: ["CWE-22"],
    products: [product("vmware", "vcenter_server", ["6.5", "6.7", "7.0"])],
    mitigation:
      "Atualize o vCenter Server; restrinja o acesso à interface de gerenciamento; monitore uploads e caminhos anômalos; segmente a rede de administração.",
    references: [reference("https://www.vmware.com/security/advisories/VMSA-2021-0002.html")],
  }),
];

/** Retorna uma cópia defensiva do seed (evita mutação acidental). */
export function seedCves(): CveRecord[] {
  return SEED_CVES.map((cve) => ({
    ...cve,
    cvss: cve.cvss ? { ...cve.cvss } : undefined,
    cwes: [...cve.cwes],
    weaknesses: [...cve.weaknesses],
    products: cve.products.map((item) => ({ ...item, versions: [...item.versions] })),
    references: cve.references.map((item) => ({ ...item, tags: [...item.tags] })),
  }));
}
