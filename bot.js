const wppconnect = require("@wppconnect-team/wppconnect");
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");
const amqp = require("amqplib");

// =====================================================
// CONFIGURAÇÃO
// =====================================================

const CONFIG_PATH = path.join(__dirname, "config.json");

const MONGO_URI = "mongodb://127.0.0.1:27017";
const MONGO_DATABASE = "whatsapp_bot";
const MONGO_COLLECTION = "reacoes";
const MONGO_ENVIOS_COLLECTION = "envios";
const MONGO_ANOMALY_NOTIFICATIONS_COLLECTION =
    "anomaly_notifications";

// =====================================================
// RABBITMQ / SERVIÇO DE ANOMALIAS
// =====================================================

const RABBITMQ_URL =
    process.env.RABBITMQ_URL ||
    "amqp://127.0.0.1:5672";

const FILA_ANALISE =
    "checagem.anomaly.run";

const FILA_RESULTADO =
    "checagem.anomaly.result";

const dias = [
    "domingo.jpg",
    "segunda.jpg",
    "terca.jpg",
    "quarta.jpg",
    "quinta.jpg",
    "sexta.png",
    "sabado.jpg"
];

const DURACAO_MONITORAMENTO =
    24 * 60 * 60 * 1000;

// =====================================================
// CONFIG DINÂMICA
// =====================================================

let config = {
    grupos: [],
    horario_envio: "08:00",
    pasta_imagens: "imagens",
    intervalo_reacao: 2000
};

// =====================================================
// MEMÓRIA
// =====================================================

const ultimosEnvios = new Map();
const monitoramentos = new Map();

// =====================================================
// MONGODB
// =====================================================

let mongoClient;
let db;
let reacoesCollection;
let enviosCollection;
let anomalyNotificationsCollection;

// =====================================================
// RABBITMQ
// =====================================================

let rabbitConnection = null;
let rabbitChannel = null;
let rabbitConectando = false;
let rabbitConsumerAtivo = false;

const analisesPendentes =
    new Map();

const analisesAgendadas =
    new Set();

// =====================================================
// UTILIDADES
// =====================================================

function esperar(ms) {
    return new Promise(
        resolve =>
            setTimeout(
                resolve,
                ms
            )
    );
}

function normalizarNomeGrupo(nome) {
    return (nome || "")
        .trim()
        .toLowerCase();
}

function obterNomeImagemAtual(
    data = new Date()
) {
    return dias[
        data.getDay()
    ];
}

function dataAtual() {
    return new Date()
        .toLocaleDateString(
            "pt-BR"
        );
}

function chaveDataLocal(
    data
) {
    const ano =
        data.getFullYear();

    const mes =
        String(
            data.getMonth() + 1
        ).padStart(
            2,
            "0"
        );

    const dia =
        String(
            data.getDate()
        ).padStart(
            2,
            "0"
        );

    return `${ano}-${mes}-${dia}`;
}

function horarioEmData(
    dataBase,
    horario = config.horario_envio
) {
    const [hora, minuto] =
        String(
            horario
        )
            .split(":")
            .map(Number);

    const data =
        new Date(
            dataBase
        );

    data.setHours(
        Number.isFinite(hora)
            ? hora
            : 8,

        Number.isFinite(minuto)
            ? minuto
            : 0,

        0,
        0
    );

    return data;
}

// =====================================================
// CICLO DA CHECAGEM
// =====================================================

function obterCicloAtivo(
    agora = new Date()
) {
    const horarioHoje =
        horarioEmData(
            agora,
            config.horario_envio
        );

    let inicio;

    if (
        agora >= horarioHoje
    ) {
        inicio =
            horarioHoje;

    } else {
        const ontem =
            new Date(
                agora
            );

        ontem.setDate(
            ontem.getDate() - 1
        );

        inicio =
            horarioEmData(
                ontem,
                config.horario_envio
            );
    }

    const fim =
        new Date(
            inicio
        );

    fim.setDate(
        fim.getDate() + 1
    );

    return {
        ciclo:
            chaveDataLocal(
                inicio
            ),

        inicio,
        fim
    };
}

// =====================================================
// CONFIG.JSON
// =====================================================

function carregarConfig() {
    try {
        if (
            !fs.existsSync(
                CONFIG_PATH
            )
        ) {
            console.error(
                `❌ Arquivo config.json não encontrado: ${CONFIG_PATH}`
            );

            return;
        }

        const conteudo =
            fs.readFileSync(
                CONFIG_PATH,
                "utf8"
            );

        const novoConfig =
            JSON.parse(
                conteudo
            );

        let grupos = [];

        if (
            Array.isArray(
                novoConfig.grupos
            )
        ) {
            grupos =
                novoConfig.grupos;

        } else if (
            typeof novoConfig.grupo ===
            "string"
        ) {
            grupos = [
                novoConfig.grupo
            ];
        }

        grupos =
            grupos
                .filter(
                    grupo =>
                        typeof grupo ===
                            "string" &&
                        grupo.trim() !==
                            ""
                )
                .map(
                    grupo =>
                        grupo.trim()
                );

        config = {
            ...config,
            ...novoConfig,
            grupos
        };

        console.log(
            "\n================================="
        );

        console.log(
            " CONFIGURAÇÃO ATUALIZADA"
        );

        console.log(
            "================================="
        );

        console.log(
            "Grupos:",
            config.grupos
        );

        console.log(
            "Horário:",
            config.horario_envio
        );

        console.log(
            "Pasta imagens:",
            config.pasta_imagens
        );

        console.log(
            "Intervalo reação:",
            config.intervalo_reacao,
            "ms"
        );

        console.log(
            "=================================\n"
        );

    } catch (erro) {
        console.error(
            "❌ Erro ao carregar config.json:",
            erro.message
        );
    }
}

// =====================================================
// MONITORA CONFIG.JSON
// =====================================================

function monitorarArquivoConfig() {
    fs.watchFile(
        CONFIG_PATH,

        {
            interval: 1000
        },

        (curr, prev) => {
            if (
                curr.mtimeMs !==
                prev.mtimeMs
            ) {
                console.log(
                    "\n🔄 config.json alterado!"
                );

                carregarConfig();
            }
        }
    );

    console.log(
        "👀 Monitorando alterações no config.json..."
    );
}

// =====================================================
// IDENTIFICA RESULTADO
// =====================================================

function identificarResultado(
    emote
) {
    if (!emote) {
        return null;
    }

    const emoteNormalizado =
        emote.replace(
            /[\u{1F3FB}-\u{1F3FF}]/gu,
            ""
        );

    if (
        emoteNormalizado ===
        "👍"
    ) {
        return "DURO";
    }

    const coracoes = [
        "❤️",
        "🧡",
        "💛",
        "💚",
        "💙",
        "💜",
        "🖤",
        "🤍",
        "🤎",
        "🩷",
        "🩵",
        "🩶"
    ];

    if (
        coracoes.includes(
            emoteNormalizado
        )
    ) {
        return "MOLE";
    }

    return null;
}

// =====================================================
// MONGODB
// =====================================================

async function conectarMongo() {
    console.log(
        "\n================================="
    );

    console.log(
        " CONECTANDO AO MONGODB"
    );

    console.log(
        "================================="
    );

    mongoClient =
        new MongoClient(
            MONGO_URI
        );

    await mongoClient.connect();

    db =
        mongoClient.db(
            MONGO_DATABASE
        );

    reacoesCollection =
        db.collection(
            MONGO_COLLECTION
        );

    enviosCollection =
        db.collection(
            MONGO_ENVIOS_COLLECTION
        );

    anomalyNotificationsCollection =
        db.collection(
            MONGO_ANOMALY_NOTIFICATIONS_COLLECTION
        );

    await reacoesCollection.createIndex(
        {
            messageId: 1,
            participantId: 1
        },

        {
            unique: true
        }
    );

    await enviosCollection.createIndex(
        {
            grupoId: 1,
            ciclo: 1
        },

        {
            unique: true
        }
    );

    await enviosCollection.createIndex(
        {
            enviadoEm: -1
        }
    );

    await anomalyNotificationsCollection.createIndex(
        {
            runId: 1,
            grupoId: 1
        },

        {
            unique: true
        }
    );

    console.log(
        `Banco: ${MONGO_DATABASE}`
    );

    console.log(
        `Coleção reações: ${MONGO_COLLECTION}`
    );

    console.log(
        `Coleção envios: ${MONGO_ENVIOS_COLLECTION}`
    );

    console.log(
        `Coleção notificações IA: ${MONGO_ANOMALY_NOTIFICATIONS_COLLECTION}`
    );

    console.log(
        "MongoDB conectado!"
    );
}

// =====================================================
// SALVA REAÇÃO
// =====================================================

async function salvarReacaoMongo({
    messageId,
    grupoId,
    grupoNome,
    fromMe,
    participantId,
    name,
    telefone,
    emote,
    resultado,
    timestamp
}) {
    if (
        !reacoesCollection
    ) {
        throw new Error(
            "MongoDB ainda não está conectado."
        );
    }

    const agora =
        new Date();

    const resultadoMongo =
        await reacoesCollection.updateOne(
            {
                messageId,
                participantId
            },

            {
                $set: {
                    messageId,
                    grupoId,
                    grupoNome,
                    fromMe,
                    participantId,
                    name,
                    telefone,
                    emote,
                    resultado,
                    isDeleted: false,
                    timestamp,
                    updatedAt: agora
                },

                $setOnInsert: {
                    createdAt:
                        agora
                }
            },

            {
                upsert: true
            }
        );

    console.log(
        "💾 REAÇÃO SALVA NO MONGODB"
    );

    console.log(
        "Grupo:",
        grupoNome
    );

    console.log(
        "Participante:",
        participantId
    );

    console.log(
        "Emote:",
        emote
    );

    console.log(
        "Resultado:",
        resultado ||
        "IGNORADO"
    );

    return resultadoMongo;
}

// =====================================================
// DELETA REAÇÃO
// =====================================================

async function deletarReacaoMongo(
    messageId,
    participantId
) {
    if (
        !reacoesCollection
    ) {
        throw new Error(
            "MongoDB ainda não está conectado."
        );
    }

    const resultado =
        await reacoesCollection.deleteOne({
            messageId,
            participantId
        });

    if (
        resultado.deletedCount >
        0
    ) {
        console.log(
            "🗑️ REAÇÃO DELETADA DO MONGODB"
        );

    } else {
        console.log(
            "⚠️ Reação não encontrada no MongoDB."
        );
    }

    return resultado;
}

// =====================================================
// CONTAGEM / BUSCA
// =====================================================

async function contarReacoes(
    messageId
) {
    return await reacoesCollection
        .countDocuments({
            messageId
        });
}

async function buscarReacoes(
    messageId
) {
    return await reacoesCollection
        .find({
            messageId
        })
        .sort({
            timestamp: 1
        })
        .toArray();
}

// =====================================================
// PERSISTÊNCIA DOS ENVIOS
// =====================================================

async function salvarEnvioMongo({
    messageId,
    grupoId,
    grupoNome,
    ciclo,
    enviadoEm
}) {
    await enviosCollection.updateOne(
        {
            grupoId,
            ciclo
        },

        {
            $set: {
                messageId,
                grupoId,
                grupoNome,
                ciclo,
                enviadoEm,
                atualizadoEm:
                    new Date()
            },

            $setOnInsert: {
                criadoEm:
                    new Date()
            }
        },

        {
            upsert: true
        }
    );

    console.log(
        `💾 Envio persistido: ${grupoNome} / ${ciclo}`
    );
}

async function buscarEnvioDoCiclo(
    grupoId,
    ciclo
) {
    return await enviosCollection.findOne({
        grupoId,
        ciclo
    });
}

// =====================================================
// RECUPERA ENVIO LEGADO
// =====================================================

async function buscarEnvioLegadoPelasReacoes({
    grupoId,
    grupoNome,
    ciclo,
    inicio,
    fim
}) {
    const registro =
        await reacoesCollection.findOne(
            {
                grupoId,

                $or: [
                    {
                        createdAt: {
                            $gte:
                                inicio,

                            $lt:
                                fim
                        }
                    },

                    {
                        updatedAt: {
                            $gte:
                                inicio,

                            $lt:
                                fim
                        }
                    }
                ]
            },

            {
                sort: {
                    createdAt: -1,
                    updatedAt: -1
                }
            }
        );

    if (
        !registro?.messageId
    ) {
        return null;
    }

    const envio = {
        messageId:
            registro.messageId,

        grupoId,

        grupoNome:
            registro.grupoNome ||
            grupoNome,

        ciclo,

        enviadoEm:
            registro.createdAt ||
            inicio
    };

    await salvarEnvioMongo(
        envio
    );

    console.log(
        `♻️ Envio antigo recuperado pelas reações: ${envio.messageId}`
    );

    return envio;
}

// =====================================================
// CARREGA REAÇÕES NO MONITORAMENTO
// =====================================================

async function carregarReacoesNoMonitoramento(
    monitoramento
) {
    const registros =
        await buscarReacoes(
            monitoramento.messageId
        );

    for (
        const registro
        of registros
    ) {
        monitoramento.reacoes.set(
            registro.participantId,

            {
                fromMe:
                    registro.fromMe ??
                    false,

                participantId:
                    registro.participantId,

                name:
                    registro.name ||
                    "",

                telefone:
                    registro.telefone ||
                    "",

                emote:
                    registro.emote ||
                    "",

                resultado:
                    registro.resultado ||
                    null,

                isDeleted:
                    registro.isDeleted ??
                    false,

                timestamp:
                    registro.timestamp,

                total:
                    registros.length
            }
        );
    }

    return registros.length;
}

// =====================================================
// NOTIFICAÇÃO DE REAÇÃO
// =====================================================

async function enviarNotificacaoReacao({
    client,
    grupoOrigemNome,
    emote,
    name,
    timestamp
}) {
    try {
        if (
            !Array.isArray(
                config.grupos
            ) ||
            config.grupos.length ===
                0
        ) {
            return;
        }

        const resultado =
            identificarResultado(
                emote
            );

        if (!resultado) {
            return;
        }

        const estado =
            resultado === "DURO"
                ? "de pau duro"
                : "de pau mole";

        const data =
            timestamp
                ? new Date(
                    timestamp
                )
                : new Date();

        const hora =
            data.toLocaleTimeString(
                "pt-BR",

                {
                    hour:
                        "2-digit",

                    minute:
                        "2-digit",

                    hour12:
                        false
                }
            );

        const nomePessoa =
            name &&
            name.trim()
                ? name.trim()
                : "Pessoa desconhecida";

        const mensagemBot =
            `🤖 *BOT DA CHECAGEM*\n\n` +
            `Às *${hora}*, *${nomePessoa}* (${grupoOrigemNome}) ` +
            `reportou que estava ${estado} 🍆\n\n` +
            `✅ Voto registrado com sucesso!`;

        const gruposWhatsApp =
            await encontrarGrupos(
                client
            );

        for (
            const nomeGrupo
            of config.grupos
        ) {
            const alvo =
                normalizarNomeGrupo(
                    nomeGrupo
                );

            const grupo =
                gruposWhatsApp.find(
                    grupo =>
                        normalizarNomeGrupo(
                            grupo.name
                        ) === alvo
                );

            if (!grupo) {
                continue;
            }

            try {
                await client.sendText(
                    grupo.id._serialized,
                    mensagemBot
                );

                console.log(
                    `✅ Resultado enviado para: ${grupo.name}`
                );

            } catch (erro) {
                console.error(
                    `❌ Erro enviando resultado para ${grupo.name}:`,
                    erro
                );
            }

            await esperar(
                500
            );
        }

    } catch (erro) {
        console.error(
            "❌ Erro ao enviar notificações:",
            erro
        );
    }
}

// =====================================================
// RABBITMQ / ANÁLISE DE ANOMALIAS
// =====================================================

function formatarDataISO(
    data
) {
    return chaveDataLocal(
        data
    );
}

function obterDataReferenciaAnalise(
    inicioCiclo
) {
    const data =
        new Date(
            inicioCiclo
        );

    data.setDate(
        data.getDate() - 1
    );

    return formatarDataISO(
        data
    );
}

function criarRunIdAnalise(
    ciclo
) {
    return `checagem-anomaly-${ciclo}`;
}

async function notificacaoAnomaliaJaEnviada(
    runId,
    grupoId
) {
    const registro =
        await anomalyNotificationsCollection.findOne({
            runId,
            grupoId,
            status: "SENT"
        });

    return Boolean(
        registro
    );
}

async function marcarNotificacaoAnomaliaEnviada({
    runId,
    grupoId,
    grupoNome
}) {
    await anomalyNotificationsCollection.updateOne(
        {
            runId,
            grupoId
        },

        {
            $set: {
                runId,
                grupoId,
                grupoNome,

                status:
                    "SENT",

                sentAt:
                    new Date(),

                updatedAt:
                    new Date()
            },

            $setOnInsert: {
                createdAt:
                    new Date()
            }
        },

        {
            upsert: true
        }
    );
}

function montarMensagemResumoAnomalias(
    resultado
) {
    const anomalias =
        Array.isArray(
            resultado.anomalias
        )
            ? resultado.anomalias
            : [];

    const totalUsuarios =
        Number(
            resultado.totalUsuarios ||
            0
        );

    if (
        anomalias.length ===
        0
    ) {
        return (
            `🤖 *ANÁLISE DIÁRIA CONCLUÍDA*\n` +
            `Ánalise por inteligencia artificial, foi finalizada com sucesso\n\n` +
            `👥 Participantes analisados: *${totalUsuarios}*\n\n` +
            `✅ Nenhuma anomalia encontrada hoje.`
        );
    }

    let mensagem =
        `🤖 *ANÁLISE DIÁRIA CONCLUÍDA*\n` +
        `Ánalise por inteligencia artificial, foi finalizada com sucesso\n\n` +
        `👥 Participantes analisados: *${totalUsuarios}*\n` +
        `⚠️ Anomalias ajustadas: *${anomalias.length}*\n\n`;

    for (
        const anomalia
        of anomalias
    ) {
        const score =
            Math.round(
                Number(
                    anomalia.score ||
                    0
                ) * 100
            );

        mensagem +=
            `👤 *${anomalia.nome || "Desconhecido"}*\n` +
            `📅 ${anomalia.data || "Data não informada"}\n` +
            `${anomalia.original || "?"} → ${anomalia.corrigido || "?"}\n` +
            `Confiança: *${score}%*\n\n`;
    }

    return mensagem.trim();
}

async function enviarResumoAnomaliasParaTodos(
    client,
    resultado
) {
    const runId =
        resultado.runId;

    if (!runId) {
        throw new Error(
            "Resultado de anomalias sem runId."
        );
    }

    const mensagem =
        montarMensagemResumoAnomalias(
            resultado
        );

    const gruposWhatsApp =
        await encontrarGrupos(
            client
        );

    const erros = [];

    for (
        const nomeGrupo
        of config.grupos
    ) {
        const alvo =
            normalizarNomeGrupo(
                nomeGrupo
            );

        const grupo =
            gruposWhatsApp.find(
                item =>
                    normalizarNomeGrupo(
                        item.name
                    ) === alvo
            );

        if (!grupo) {
            erros.push(
                `Grupo não encontrado: ${nomeGrupo}`
            );

            continue;
        }

        const grupoId =
            grupo.id._serialized;

        const jaEnviada =
            await notificacaoAnomaliaJaEnviada(
                runId,
                grupoId
            );

        if (
            jaEnviada
        ) {
            console.log(
                `♻️ Relatório ${runId} já enviado para ${grupo.name}.`
            );

            continue;
        }

        try {
            await client.sendText(
                grupoId,
                mensagem
            );

            await marcarNotificacaoAnomaliaEnviada({
                runId,
                grupoId,
                grupoNome:
                    grupo.name
            });

            console.log(
                `✅ Relatório de anomalias enviado para: ${grupo.name}`
            );

        } catch (erro) {
            console.error(
                `❌ Erro enviando relatório para ${grupo.name}:`,
                erro
            );

            erros.push(
                `${grupo.name}: ${
                    erro.message ||
                    erro
                }`
            );
        }

        await esperar(
            500
        );
    }

    if (
        erros.length >
        0
    ) {
        throw new Error(
            erros.join(
                " | "
            )
        );
    }
}

async function consumirResultadosAnomalias(
    client
) {
    if (
        !rabbitChannel ||
        rabbitConsumerAtivo
    ) {
        return;
    }

    rabbitConsumerAtivo =
        true;

    await rabbitChannel.consume(
        FILA_RESULTADO,

        async mensagem => {
            if (
                !mensagem
            ) {
                return;
            }

            try {
                const resultado =
                    JSON.parse(
                        mensagem.content.toString(
                            "utf8"
                        )
                    );

                console.log(
                    "\n================================="
                );

                console.log(
                    " 🧠 RESULTADO DA ANÁLISE RECEBIDO"
                );

                console.log(
                    "================================="
                );

                console.log(
                    resultado
                );

                await enviarResumoAnomaliasParaTodos(
                    client,
                    resultado
                );

                rabbitChannel.ack(
                    mensagem
                );

            } catch (erro) {
                console.error(
                    "❌ Erro processando resultado da análise:",
                    erro
                );

                try {
                    rabbitChannel.nack(
                        mensagem,
                        false,
                        true
                    );
                } catch (
                    nackErro
                ) {
                    console.error(
                        nackErro
                    );
                }
            }
        },

        {
            noAck: false
        }
    );
}

async function tentarPublicarAnalisesPendentes() {
    if (
        !rabbitChannel ||
        analisesPendentes.size ===
            0
    ) {
        return;
    }

    for (
        const [
            runId,
            payload
        ]
        of analisesPendentes
    ) {
        try {
            rabbitChannel.sendToQueue(
                FILA_ANALISE,

                Buffer.from(
                    JSON.stringify(
                        payload
                    ),

                    "utf8"
                ),

                {
                    persistent: true,
                    contentType:
                        "application/json"
                }
            );

            analisesPendentes.delete(
                runId
            );

            console.log(
                `🧠 Análise publicada no RabbitMQ: ${runId}`
            );

        } catch (erro) {
            console.error(
                `❌ Erro publicando ${runId}:`,
                erro.message
            );

            break;
        }
    }
}

function solicitarAnaliseDoCiclo(
    cicloInfo
) {
    if (
        !cicloInfo?.ciclo ||
        !cicloInfo?.inicio
    ) {
        return;
    }

    const runId =
        criarRunIdAnalise(
            cicloInfo.ciclo
        );

    if (
        analisesAgendadas.has(
            runId
        )
    ) {
        return;
    }

    analisesAgendadas.add(
        runId
    );

    const payload = {
        runId,

        dataReferencia:
            obterDataReferenciaAnalise(
                cicloInfo.inicio
            ),

        ciclo:
            cicloInfo.ciclo,

        solicitadoEm:
            new Date().toISOString()
    };

    analisesPendentes.set(
        runId,
        payload
    );

    tentarPublicarAnalisesPendentes()
        .catch(
            erro =>
                console.error(
                    erro
                )
        );
}

async function conectarRabbitUmaVez(
    client
) {
    if (
        rabbitChannel ||
        rabbitConectando
    ) {
        return;
    }

    rabbitConectando =
        true;

    try {
        console.log(
            "🐇 Conectando ao RabbitMQ..."
        );

        rabbitConnection =
            await amqp.connect(
                RABBITMQ_URL
            );

        rabbitConnection.on(
            "error",
            erro => {
                console.error(
                    "❌ RabbitMQ:",
                    erro.message
                );
            }
        );

        rabbitConnection.on(
            "close",
            () => {
                rabbitConnection =
                    null;

                rabbitChannel =
                    null;

                rabbitConsumerAtivo =
                    false;
            }
        );

        rabbitChannel =
            await rabbitConnection.createChannel();

        await rabbitChannel.assertQueue(
            FILA_ANALISE,

            {
                durable: true
            }
        );

        await rabbitChannel.assertQueue(
            FILA_RESULTADO,

            {
                durable: true
            }
        );

        await rabbitChannel.prefetch(
            1
        );

        console.log(
            "✅ RabbitMQ conectado."
        );

        await consumirResultadosAnomalias(
            client
        );

        await tentarPublicarAnalisesPendentes();

    } finally {
        rabbitConectando =
            false;
    }
}

function iniciarRabbitEmBackground(
    client
) {
    conectarRabbitUmaVez(
        client
    ).catch(
        erro =>
            console.error(
                "⚠️ RabbitMQ indisponível:",
                erro.message
            )
    );

    setInterval(
        async () => {
            if (
                !rabbitChannel
            ) {
                await conectarRabbitUmaVez(
                    client
                ).catch(
                    erro =>
                        console.error(
                            "⚠️ Falha reconectando RabbitMQ:",
                            erro.message
                        )
                );

                return;
            }

            await tentarPublicarAnalisesPendentes()
                .catch(
                    erro =>
                        console.error(
                            erro
                        )
                );
        },

        15000
    );
}

// =====================================================
// LISTENER DE REAÇÕES
// =====================================================

function configurarMonitoramentoDeReacoes(
    client
) {
    client.onReactionMessage(
        async reaction => {
            try {
                console.log(
                    "\n=============================="
                );

                console.log(
                    "🔥 REAÇÃO RECEBIDA!"
                );

                console.log(
                    "=============================="
                );

                const idMensagemReagida =
                    reaction.msgId?._serialized ||
                    reaction.msgId;

                const monitoramento =
                    monitoramentos.get(
                        idMensagemReagida
                    );

                if (
                    !monitoramento
                ) {
                    console.log(
                        "⚠️ Essa mensagem não está sendo monitorada."
                    );

                    return;
                }

                const participantId =
                    reaction.id?.participant ||
                    reaction.author ||
                    reaction.from;

                if (
                    !participantId
                ) {
                    return;
                }

                const emote =
                    reaction.reactionText ||
                    "";

                const isDeleted =
                    emote === "";

                const resultado =
                    isDeleted
                        ? null
                        : identificarResultado(
                            emote
                        );

                let name = "";
                let telefone = "";

                try {
                    const contato =
                        await client.getContact(
                            participantId
                        );

                    if (
                        contato
                    ) {
                        name =
                            contato.name ||
                            contato.pushname ||
                            contato.shortName ||
                            "";

                        telefone =
                            contato.id?.user ||
                            contato.number ||
                            contato.userid ||
                            "";
                    }

                } catch (erro) {
                    console.log(
                        "⚠️ Não foi possível buscar contato:",
                        erro.message
                    );
                }

                if (
                    !name
                ) {
                    try {
                        const mensagem =
                            await client.getMessageById(
                                idMensagemReagida
                            );

                        if (
                            mensagem?.sender
                        ) {
                            name =
                                mensagem.sender.pushname ||
                                mensagem.sender.formattedName ||
                                "";
                        }

                    } catch (erro) {
                        // fallback silencioso
                    }
                }

                if (
                    telefone &&
                    telefone.includes(
                        "@"
                    )
                ) {
                    telefone = "";
                }

                const timestamp =
                    reaction.timestamp ||
                    Math.floor(
                        Date.now() /
                        1000
                    );

                if (
                    isDeleted
                ) {
                    await deletarReacaoMongo(
                        idMensagemReagida,
                        participantId
                    );

                    monitoramento.reacoes.delete(
                        participantId
                    );

                } else {
                    const dadosReacao = {
                        messageId:
                            idMensagemReagida,

                        grupoId:
                            monitoramento.grupoId,

                        grupoNome:
                            monitoramento.grupoNome,

                        fromMe:
                            reaction.id?.fromMe ??
                            false,

                        participantId,
                        name,
                        telefone,
                        emote,
                        resultado,
                        timestamp
                    };

                    await salvarReacaoMongo(
                        dadosReacao
                    );

                    monitoramento.reacoes.set(
                        participantId,

                        {
                            ...dadosReacao,
                            isDeleted:
                                false,

                            total:
                                0
                        }
                    );

                    if (
                        resultado
                    ) {
                        await enviarNotificacaoReacao({
                            client,

                            grupoOrigemNome:
                                monitoramento.grupoNome,

                            emote,
                            name,

                            timestamp:
                                timestamp *
                                1000
                        });
                    }
                }

                const total =
                    await contarReacoes(
                        idMensagemReagida
                    );

                for (
                    const registro
                    of monitoramento.reacoes.values()
                ) {
                    registro.total =
                        total;
                }

                console.log(
                    "Total:",
                    total
                );

            } catch (erro) {
                console.error(
                    "\n❌ ERRO AO PROCESSAR REAÇÃO:",
                    erro
                );
            }
        }
    );
}

// =====================================================
// INICIA MONITORAMENTO
// =====================================================

async function iniciarMonitoramento({
    mensagem = null,
    messageId:
        messageIdInformado = null,
    grupoId,
    grupoNome,
    inicio = new Date(),
    fim = new Date(
        Date.now() +
        DURACAO_MONITORAMENTO
    ),
    recuperado = false
}) {
    const messageId =
        messageIdInformado ||
        mensagem?.id?._serialized ||
        mensagem?.id;

    if (
        !messageId
    ) {
        throw new Error(
            `Não foi possível identificar o messageId de ${grupoNome}.`
        );
    }

    const existente =
        monitoramentos.get(
            messageId
        );

    if (
        existente
    ) {
        return existente;
    }

    if (
        fim <=
        new Date()
    ) {
        return null;
    }

    const monitoramento = {
        messageId,
        grupoId,
        grupoNome,
        mensagem,
        inicio,
        fim,
        recuperado,
        reacoes:
            new Map(),
        timeout:
            null
    };

    monitoramentos.set(
        messageId,
        monitoramento
    );

    const totalRecuperado =
        await carregarReacoesNoMonitoramento(
            monitoramento
        );

    console.log(
        recuperado
            ? `♻️ Monitoramento recuperado: ${grupoNome}`
            : `✅ Monitoramento iniciado: ${grupoNome}`
    );

    console.log(
        "Reações recuperadas:",
        totalRecuperado
    );

    const tempoRestante =
        Math.max(
            1,

            fim.getTime() -
            Date.now()
        );

    monitoramento.timeout =
        setTimeout(
            async () => {
                try {
                    await mostrarReacoes(
                        messageId
                    );

                    monitoramentos.delete(
                        messageId
                    );

                } catch (erro) {
                    console.error(
                        erro
                    );
                }
            },

            tempoRestante
        );

    return monitoramento;
}

// =====================================================
// MOSTRA REAÇÕES
// =====================================================

async function mostrarReacoes(
    messageId
) {
    const registros =
        await buscarReacoes(
            messageId
        );

    console.log(
        "\n===== REAÇÕES ATUAIS ====="
    );

    if (
        registros.length ===
        0
    ) {
        console.log(
            "Nenhuma reação registrada."
        );

        return;
    }

    for (
        const registro
        of registros
    ) {
        console.log(
            `${registro.emote} ${
                registro.name ||
                registro.participantId
            } → ${
                registro.resultado ||
                "IGNORADO"
            }`
        );
    }

    console.log(
        `Total: ${registros.length}`
    );
}

// =====================================================
// ENCONTRA GRUPOS
// =====================================================

async function encontrarGrupos(
    client
) {
    const chats =
        await client.listChats();

    const grupos =
        chats.filter(
            chat =>
                chat.isGroup
        );

    console.log(
        `📋 ${grupos.length} grupos encontrados no WhatsApp.`
    );

    return grupos;
}

// =====================================================
// ENVIA CHECAGEM PARA GRUPO
// =====================================================

async function enviarChecagemParaGrupo({
    client,
    grupo,
    cicloInfo =
        obterCicloAtivo(
            new Date()
        )
}) {
    console.log(
        `📤 Preparando checagem para ${grupo.name}`
    );

    const nomeImagem =
        obterNomeImagemAtual(
            new Date()
        );

    const imagem =
        path.join(
            __dirname,
            config.pasta_imagens,
            nomeImagem
        );

    if (
        !fs.existsSync(
            imagem
        )
    ) {
        console.error(
            `❌ Imagem não encontrada: ${imagem}`
        );

        return;
    }

    const agora =
        new Date();

    const data =
        agora.toLocaleDateString(
            "pt-BR",

            {
                day:
                    "2-digit",

                month:
                    "2-digit",

                year:
                    "numeric"
            }
        );

    const legenda =
        `🚨🍆 *CHECAGEM DE PAU DIÁRIA* 🍆🚨\n\n` +
        `📅 *Data:* ${data}\n\n` +
        `Senhores, está oficialmente aberta a checagem de hoje.\n\n` +
        `Reajam a *esta mensagem* de acordo com a situação atual:\n\n` +
        `👍 *DURO*\n` +
        `❤️ *MOLE*\n\n` +
        `⚠️ *Não esqueçam de reagir!* Sua participação será computada nas estatísticas oficiais da checagem.\n\n` +
        `📊 *Dashboard da Checagem:*\n` +
        `https://www.server-home.space/\n\n` +
        `Boa checagem a todos. 🫡🍆`;

    const envioExistente =
        await buscarEnvioDoCiclo(
            grupo.id._serialized,
            cicloInfo.ciclo
        );

    if (
        envioExistente
    ) {
        ultimosEnvios.set(
            normalizarNomeGrupo(
                grupo.name
            ),

            cicloInfo.ciclo
        );

        await iniciarMonitoramento({
            messageId:
                envioExistente.messageId,

            grupoId:
                grupo.id._serialized,

            grupoNome:
                grupo.name,

            inicio:
                cicloInfo.inicio,

            fim:
                cicloInfo.fim,

            recuperado:
                true
        });

        return;
    }

    const mensagem =
        await client.sendImage(
            grupo.id._serialized,
            imagem,
            nomeImagem,
            legenda
        );

    if (
        !mensagem
    ) {
        throw new Error(
            `WhatsApp não retornou mensagem para ${grupo.name}`
        );
    }

    const messageId =
        mensagem.id?._serialized ||
        mensagem.id;

    await salvarEnvioMongo({
        messageId,

        grupoId:
            grupo.id._serialized,

        grupoNome:
            grupo.name,

        ciclo:
            cicloInfo.ciclo,

        enviadoEm:
            agora
    });

    await iniciarMonitoramento({
        mensagem,
        messageId,

        grupoId:
            grupo.id._serialized,

        grupoNome:
            grupo.name,

        inicio:
            cicloInfo.inicio,

        fim:
            cicloInfo.fim,

        recuperado:
            false
    });

    ultimosEnvios.set(
        normalizarNomeGrupo(
            grupo.name
        ),

        cicloInfo.ciclo
    );

    console.log(
        `✅ Checagem enviada: ${grupo.name}`
    );
}

// =====================================================
// ENVIA POR NOME
// =====================================================

async function enviarChecagemParaGrupoPorNome(
    client,
    nomeGrupo,
    cicloInfo
) {
    const grupos =
        await encontrarGrupos(
            client
        );

    const alvo =
        normalizarNomeGrupo(
            nomeGrupo
        );

    const grupo =
        grupos.find(
            grupo =>
                normalizarNomeGrupo(
                    grupo.name
                ) === alvo
        );

    if (
        !grupo
    ) {
        throw new Error(
            `Grupo "${nomeGrupo}" não encontrado.`
        );
    }

    await enviarChecagemParaGrupo({
        client,
        grupo,
        cicloInfo
    });
}

// =====================================================
// RECUPERA OU GARANTE CHECAGENS
// =====================================================

async function recuperarOuGarantirChecagens(
    client
) {
    console.log(
        "\n================================="
    );

    console.log(
        " RECUPERANDO CHECAGENS"
    );

    console.log(
        "================================="
    );

    const agora =
        new Date();

    const cicloInfo =
        obterCicloAtivo(
            agora
        );

    const horarioHoje =
        horarioEmData(
            agora,
            config.horario_envio
        );

    if (
        agora >=
            horarioHoje &&
        chaveDataLocal(
            cicloInfo.inicio
        ) ===
            chaveDataLocal(
                horarioHoje
            )
    ) {
        solicitarAnaliseDoCiclo(
            cicloInfo
        );
    }

    const gruposWhatsApp =
        await encontrarGrupos(
            client
        );

    for (
        const nomeGrupo
        of config.grupos
    ) {
        const alvo =
            normalizarNomeGrupo(
                nomeGrupo
            );

        const grupo =
            gruposWhatsApp.find(
                item =>
                    normalizarNomeGrupo(
                        item.name
                    ) === alvo
            );

        if (
            !grupo
        ) {
            console.error(
                `❌ Grupo "${nomeGrupo}" não encontrado.`
            );

            continue;
        }

        const grupoId =
            grupo.id._serialized;

        let envio =
            await buscarEnvioDoCiclo(
                grupoId,
                cicloInfo.ciclo
            );

        if (
            !envio
        ) {
            envio =
                await buscarEnvioLegadoPelasReacoes({
                    grupoId,

                    grupoNome:
                        grupo.name,

                    ciclo:
                        cicloInfo.ciclo,

                    inicio:
                        cicloInfo.inicio,

                    fim:
                        cicloInfo.fim
                });
        }

        if (
            envio
        ) {
            ultimosEnvios.set(
                alvo,
                cicloInfo.ciclo
            );

            await iniciarMonitoramento({
                messageId:
                    envio.messageId,

                grupoId,

                grupoNome:
                    grupo.name,

                inicio:
                    cicloInfo.inicio,

                fim:
                    cicloInfo.fim,

                recuperado:
                    true
            });

            continue;
        }

        await enviarChecagemParaGrupo({
            client,
            grupo,
            cicloInfo
        });

        await esperar(
            config.intervalo_reacao
        );
    }
}

// =====================================================
// VERIFICA NOVO CICLO
// =====================================================

async function verificarHorarioEnvio(
    client
) {
    const agora =
        new Date();

    const horarioHoje =
        horarioEmData(
            agora,
            config.horario_envio
        );

    if (
        agora <
        horarioHoje
    ) {
        return;
    }

    const cicloHoje =
        chaveDataLocal(
            horarioHoje
        );

    const fimCicloHoje =
        new Date(
            horarioHoje
        );

    fimCicloHoje.setDate(
        fimCicloHoje.getDate() +
        1
    );

    solicitarAnaliseDoCiclo({
        ciclo:
            cicloHoje,

        inicio:
            horarioHoje,

        fim:
            fimCicloHoje
    });

    for (
        const nomeGrupo
        of config.grupos
    ) {
        const chave =
            normalizarNomeGrupo(
                nomeGrupo
            );

        if (
            ultimosEnvios.get(
                chave
            ) === cicloHoje
        ) {
            continue;
        }

        ultimosEnvios.set(
            chave,
            cicloHoje
        );

        try {
            await enviarChecagemParaGrupoPorNome(
                client,
                nomeGrupo,

                {
                    ciclo:
                        cicloHoje,

                    inicio:
                        horarioHoje,

                    fim:
                        fimCicloHoje
                }
            );

        } catch (erro) {
            console.error(
                `❌ Erro no envio para ${nomeGrupo}:`,
                erro
            );

            ultimosEnvios.delete(
                chave
            );
        }
    }
}

// =====================================================
// SCHEDULER
// =====================================================

function iniciarScheduler(
    client
) {
    console.log(
        "\n⏰ Scheduler iniciado."
    );

    console.log(
        "Horário configurado:",
        config.horario_envio
    );

    let verificando =
        false;

    setInterval(
        async () => {
            if (
                verificando
            ) {
                return;
            }

            verificando =
                true;

            try {
                await verificarHorarioEnvio(
                    client
                );

            } catch (erro) {
                console.error(
                    "❌ Erro no scheduler:",
                    erro
                );

            } finally {
                verificando =
                    false;
            }
        },

        5000
    );
}

// =====================================================
// AGUARDA WHATSAPP
// =====================================================

async function esperarWhatsAppPronto(
    client
) {
    console.log(
        "Aguardando WhatsApp carregar os chats..."
    );

    for (
        let tentativa = 1;
        tentativa <= 30;
        tentativa++
    ) {
        try {
            const estado =
                await client.getConnectionState();

            console.log(
                `Tentativa ${tentativa}/30 - Estado: ${estado}`
            );

            if (
                estado ===
                "CONNECTED"
            ) {
                try {
                    const chats =
                        await client.listChats();

                    if (
                        chats &&
                        chats.length >
                            0
                    ) {
                        console.log(
                            `WhatsApp pronto! ${chats.length} chats carregados.`
                        );

                        return;
                    }

                } catch (erro) {
                    console.log(
                        "Chats ainda não disponíveis..."
                    );
                }
            }

        } catch (erro) {
            console.log(
                "Aguardando WhatsApp..."
            );
        }

        await esperar(
            3000
        );
    }

    throw new Error(
        "WhatsApp conectou, mas os chats não foram carregados."
    );
}

// =====================================================
// START
// =====================================================

async function start(
    client
) {
    console.log(
        "\n================================="
    );

    console.log(
        " WhatsApp Daily Reaction Bot"
    );

    console.log(
        "=================================\n"
    );

    carregarConfig();

    monitorarArquivoConfig();

    configurarMonitoramentoDeReacoes(
        client
    );

    await esperarWhatsAppPronto(
        client
    );

    console.log(
        "WhatsApp sincronizado!"
    );

    // RabbitMQ funciona em background.
    // Se estiver fora do ar,
    // o WhatsApp continua funcionando.
    iniciarRabbitEmBackground(
        client
    );

    console.log(
        "\n================================="
    );

    console.log(
        " GRUPOS CONFIGURADOS"
    );

    console.log(
        "================================="
    );

    for (
        const grupo
        of config.grupos
    ) {
        console.log(
            `• ${grupo}`
        );
    }

    console.log(
        "=================================\n"
    );

    await recuperarOuGarantirChecagens(
        client
    );

    iniciarScheduler(
        client
    );
}

// =====================================================
// INICIALIZAÇÃO
// =====================================================

async function iniciar() {
    try {
        carregarConfig();

        await conectarMongo();

        console.log(
            "\nIniciando WhatsApp..."
        );

        wppconnect
            .create({
                session:
                    "daily-bot",

                catchQR:
                    (
                        base64Qr,
                        asciiQR
                    ) => {
                        console.log(
                            asciiQR
                        );
                    },

                statusFind:
                    status => {
                        console.log(
                            "Status:",
                            status
                        );
                    }
            })

            .then(
                start
            )

            .catch(
                erro => {
                    console.error(
                        "❌ Erro no WhatsApp:",
                        erro
                    );
                }
            );

    } catch (erro) {
        console.error(
            "\n❌ Erro ao iniciar:",
            erro
        );

        process.exit(
            1
        );
    }
}

// =====================================================
// ENCERRAMENTO
// =====================================================

async function encerrar(
    sinal
) {
    console.log(
        `\n🛑 Recebido ${sinal}. Encerrando...`
    );

    try {
        if (
            rabbitChannel
        ) {
            try {
                await rabbitChannel.close();
            } catch (_) {
                // já fechado
            }
        }

        if (
            rabbitConnection
        ) {
            try {
                await rabbitConnection.close();
            } catch (_) {
                // já fechado
            }
        }

        if (
            mongoClient
        ) {
            await mongoClient.close();
        }

    } catch (erro) {
        console.error(
            "Erro fechando conexões:",
            erro.message
        );
    }

    process.exit(
        0
    );
}

process.on(
    "SIGINT",

    () =>
        encerrar(
            "SIGINT"
        )
);

process.on(
    "SIGTERM",

    () =>
        encerrar(
            "SIGTERM"
        )
);

// =====================================================
// START
// =====================================================

iniciar();