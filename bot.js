const wppconnect = require("@wppconnect-team/wppconnect");
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

// =====================================================
// CONFIGURAÇÃO
// =====================================================

const CONFIG_PATH = path.join(__dirname, "config.json");

const MONGO_URI = "mongodb://127.0.0.1:27017";
const MONGO_DATABASE = "whatsapp_bot";
const MONGO_COLLECTION = "reacoes";

const dias = [
    "domingo.jpg",
    "segunda.jpg",
    "terca.jpg",
    "quarta.jpg",
    "quinta.jpg",
    "sexta.png",
    "sabado.jpg"
];

const NOME_IMAGEM = dias[new Date().getDay()];

const DURACAO_MONITORAMENTO = 24 * 60 * 60 * 1000;

// =====================================================
// CONFIG DINÂMICA
// =====================================================

let config = {
    grupos: [],
    horario_envio: "08:00",
    pasta_imagens: "imagens",
    intervalo_reacao: 2000
};

// Guarda a última data em que cada grupo recebeu a checagem
const ultimosEnvios = new Map();

// =====================================================
// MONITORAMENTOS
// =====================================================
//
// Cada mensagem enviada possui seu próprio monitoramento.
//
// {
//   messageId,
//   grupoId,
//   grupoNome,
//   mensagem,
//   inicio,
//   fim,
//   reacoes: Map(),
//   timeout
// }
//

const monitoramentos = new Map();

// =====================================================
// MONGODB
// =====================================================

let mongoClient;
let db;
let reacoesCollection;

// =====================================================
// CARREGA CONFIG
// =====================================================

function carregarConfig() {

    try {

        if (!fs.existsSync(CONFIG_PATH)) {

            console.error(
                `❌ Arquivo config.json não encontrado: ${CONFIG_PATH}`
            );

            return;
        }

        const conteudo = fs.readFileSync(
            CONFIG_PATH,
            "utf8"
        );

        const novoConfig = JSON.parse(conteudo);

        // -------------------------------------------------
        // COMPATIBILIDADE
        // -------------------------------------------------
        //
        // Aceita:
        //
        // "grupo": "IGNORA"
        //
        // ou:
        //
        // "grupos": ["IGNORA", "OUTRO"]
        //

        let grupos = [];

        if (Array.isArray(novoConfig.grupos)) {

            grupos = novoConfig.grupos;

        } else if (typeof novoConfig.grupo === "string") {

            grupos = [
                novoConfig.grupo
            ];
        }

        grupos = grupos
            .filter(
                grupo =>
                    typeof grupo === "string" &&
                    grupo.trim() !== ""
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

        console.log("\n=================================");
        console.log(" CONFIGURAÇÃO ATUALIZADA");
        console.log("=================================");

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
// MONITORA ALTERAÇÕES NO CONFIG.JSON
// =====================================================

function monitorarArquivoConfig() {

    fs.watchFile(
        CONFIG_PATH,
        {
            interval: 1000
        },
        (
            curr,
            prev
        ) => {

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
// IDENTIFICA RESULTADO DA REAÇÃO
// =====================================================

function identificarResultado(emote) {

    if (!emote) {
        return null;
    }

    // -------------------------------------------------
    // Remove modificadores de tom de pele
    // -------------------------------------------------

    const emoteNormalizado =
        emote.replace(
            /[\u{1F3FB}-\u{1F3FF}]/gu,
            ""
        );

    // -------------------------------------------------
    // 👍 = DURO
    // -------------------------------------------------

    if (
        emoteNormalizado === "👍"
    ) {

        return "DURO";
    }

    // -------------------------------------------------
    // CORAÇÕES = MOLE
    // -------------------------------------------------

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

    // -------------------------------------------------
    // Índice
    // -------------------------------------------------

    await reacoesCollection.createIndex(
        {
            messageId: 1,
            participantId: 1
        },
        {
            unique: true
        }
    );

    console.log(
        `Banco: ${MONGO_DATABASE}`
    );

    console.log(
        `Coleção: ${MONGO_COLLECTION}`
    );

    console.log(
        "MongoDB conectado!"
    );
}

// =====================================================
// SALVAR / ATUALIZAR REAÇÃO
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

    if (!reacoesCollection) {

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

                    // NOVO
                    grupoNome,

                    fromMe,

                    participantId,

                    name,

                    telefone,

                    emote,

                    resultado,

                    isDeleted: false,

                    timestamp,

                    updatedAt:
                        agora
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
        resultado || "IGNORADO"
    );

    return resultadoMongo;
}

// =====================================================
// DELETAR REAÇÃO
// =====================================================

async function deletarReacaoMongo(
    messageId,
    participantId
) {

    if (!reacoesCollection) {

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
        resultado.deletedCount > 0
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
// CONTAR REAÇÕES
// =====================================================

async function contarReacoes(
    messageId
) {

    if (!reacoesCollection) {

        throw new Error(
            "MongoDB ainda não está conectado."
        );
    }

    return await reacoesCollection.countDocuments({

        messageId

    });
}

// =====================================================
// BUSCAR REAÇÕES
// =====================================================

async function buscarReacoes(
    messageId
) {

    if (!reacoesCollection) {

        throw new Error(
            "MongoDB ainda não está conectado."
        );
    }

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
// ENVIA NOTIFICAÇÃO DA REAÇÃO
// =====================================================

async function enviarNotificacaoReacao({
    client,
    grupoOrigemNome,
    emote,
    name,
    timestamp
}) {
    try {

        // =====================================================
        // CONFIG ATUAL
        // =====================================================

        const configAtual = config;

        if (
            !configAtual.grupos ||
            !Array.isArray(configAtual.grupos) ||
            configAtual.grupos.length === 0
        ) {
            console.log(
                "⚠️ Nenhum grupo participante configurado."
            );

            return;
        }

        // =====================================================
        // IDENTIFICA O RESULTADO
        // =====================================================

        const resultado =
            identificarResultado(emote);

        if (!resultado) {
            return;
        }

        // =====================================================
        // CONVERTE PARA TEXTO
        // =====================================================

        let estado;

        if (resultado === "DURO") {
            estado = "de pau duro";
        } else if (resultado === "MOLE") {
            estado = "de pau mole";
        } else {
            return;
        }

        // =====================================================
        // HORÁRIO
        // =====================================================

        const data = timestamp
            ? new Date(timestamp)
            : new Date();

        const hora =
            data.toLocaleTimeString(
                "pt-BR",
                {
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false
                }
            );

        // =====================================================
        // NOME
        // =====================================================

        const nomePessoa =
            name && name.trim()
                ? name.trim()
                : "Pessoa desconhecida";

        // =====================================================
        // MENSAGEM
        // =====================================================

        const mensagemBot =
            `🤖 *BOT DA CHECAGEM*\n\n` +
            `Às *${hora}*, *${nomePessoa}* (${grupoOrigemNome}) ` +
            `reportou que estava ${estado} 🍆\n\n` +
            `✅ Voto registrado com sucesso!`;

        console.log(
            "\n📢 ENVIANDO RESULTADO PARA TODOS OS GRUPOS:"
        );

        console.log(
            mensagemBot
        );

        // =====================================================
        // BUSCA GRUPOS DO WHATSAPP
        // =====================================================

        const gruposWhatsApp =
            await encontrarGrupos(client);

        // =====================================================
        // ENVIA PARA CADA GRUPO PARTICIPANTE
        // =====================================================

        for (
            const nomeGrupo
            of configAtual.grupos
        ) {

            const alvo =
                nomeGrupo
                    .trim()
                    .toLowerCase();

            const grupo =
                gruposWhatsApp.find(
                    grupo =>
                        grupo.name &&
                        grupo.name
                            .trim()
                            .toLowerCase() === alvo
                );

            // -------------------------------------------------
            // GRUPO NÃO ENCONTRADO
            // -------------------------------------------------

            if (!grupo) {

                console.log(
                    `⚠️ Grupo "${nomeGrupo}" não encontrado para notificação.`
                );

                continue;
            }

            // -------------------------------------------------
            // ENVIA
            // -------------------------------------------------

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

            // -------------------------------------------------
            // PEQUENO INTERVALO
            // -------------------------------------------------

            await esperar(500);
        }

    } catch (erro) {

        console.error(
            "❌ Erro ao enviar notificações:",
            erro
        );
    }
}

// =====================================================
// CONFIGURA MONITORAMENTO DAS REAÇÕES
// =====================================================

function configurarMonitoramentoDeReacoes(
    client
) {

    client.onReactionMessage(

        async (reaction) => {

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

                // -------------------------------------------------
                // ID DA MENSAGEM
                // -------------------------------------------------

                const idMensagemReagida =
                    reaction.msgId?._serialized ||
                    reaction.msgId;

                console.log(
                    "Mensagem reagida:",
                    idMensagemReagida
                );

                // -------------------------------------------------
                // PROCURA O MONITORAMENTO
                // -------------------------------------------------

                const monitoramento =
                    monitoramentos.get(
                        idMensagemReagida
                    );

                if (!monitoramento) {

                    console.log(
                        "⚠️ Essa mensagem não está sendo monitorada."
                    );

                    return;
                }

                console.log(
                    "Grupo:",
                    monitoramento.grupoNome
                );

                // -------------------------------------------------
                // PARTICIPANTE
                // -------------------------------------------------

                const participantId =

                    reaction.id?.participant ||
                    reaction.author ||
                    reaction.from;

                if (!participantId) {

                    console.log(
                        "⚠️ Participante não identificado."
                    );

                    return;
                }

                console.log(
                    "Participante:",
                    participantId
                );

                // -------------------------------------------------
                // EMOTE
                // -------------------------------------------------

                const emote =
                    reaction.reactionText ||
                    "";

                const isDeleted =
                    emote === "";

                console.log(
                    "Emote:",
                    isDeleted
                        ? "(removido)"
                        : emote
                );

                // -------------------------------------------------
                // RESULTADO
                // -------------------------------------------------

                const resultado =
                    isDeleted
                        ? null
                        : identificarResultado(
                            emote
                        );

                console.log(
                    "Resultado:",
                    resultado ||
                    "IGNORADO"
                );

                // -------------------------------------------------
                // DADOS DO USUÁRIO
                // -------------------------------------------------

                let name = "";
                let telefone = "";

                try {

                    const contato =
                        await client.getContact(
                            participantId
                        );

                    if (contato) {

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

                // -------------------------------------------------
                // FALLBACK NOME
                // -------------------------------------------------

                if (!name) {

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

                        console.log(
                            "⚠️ Não foi possível obter sender:",
                            erro.message
                        );
                    }
                }

                // -------------------------------------------------
                // @LID NÃO É TELEFONE
                // -------------------------------------------------

                if (
                    telefone &&
                    telefone.includes("@")
                ) {

                    telefone = "";
                }

                // -------------------------------------------------
                // TIMESTAMP
                // -------------------------------------------------

                const timestamp =
                    reaction.timestamp ||
                    Math.floor(
                        Date.now() / 1000
                    );

                // =================================================
                // REAÇÃO REMOVIDA
                // =================================================

                if (isDeleted) {

                    console.log(
                        "\n🗑️ PROCESSANDO REMOÇÃO..."
                    );

                    await deletarReacaoMongo(
                        idMensagemReagida,
                        participantId
                    );

                    monitoramento.reacoes.delete(
                        participantId
                    );

                }

                // =================================================
                // REAÇÃO ADICIONADA / ALTERADA
                // =================================================

                else {

                    console.log(
                        "\n💾 PROCESSANDO REAÇÃO..."
                    );

                    const dadosReacao = {

                        messageId:
                            idMensagemReagida,

                        grupoId:
                            monitoramento.grupoId,

                        // NOVO
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

                    // -------------------------------------------------
                    // SALVA NO MONGO
                    // -------------------------------------------------

                    await salvarReacaoMongo(
                        dadosReacao
                    );

                    // -------------------------------------------------
                    // MEMÓRIA
                    // -------------------------------------------------

                    monitoramento.reacoes.set(

                        participantId,

                        {

                            fromMe:
                                dadosReacao.fromMe,

                            participantId,

                            name,

                            telefone,

                            emote,

                            resultado,

                            isDeleted: false,

                            timestamp,

                            total: 0
                        }
                    );

                    // -------------------------------------------------
                    // NOTIFICAÇÃO
                    // -------------------------------------------------

                    if (resultado) {

                        await enviarNotificacaoReacao({
                            client,
                            grupoOrigemNome: monitoramento.grupoNome,
                            emote,
                            name,
                            timestamp: timestamp * 1000
                        });

                    }
                }

                // =================================================
                // TOTAL DO MONGO
                // =================================================

                const total =
                    await contarReacoes(
                        idMensagemReagida
                    );

                // -------------------------------------------------
                // ATUALIZA TOTAL LOCAL
                // -------------------------------------------------

                for (
                    const registro
                    of monitoramento.reacoes.values()
                ) {

                    registro.total =
                        total;
                }

                // =================================================
                // MOSTRA JSON
                // =================================================

                const registroAtual =
                    monitoramento.reacoes.get(
                        participantId
                    );

                console.log(
                    "\n===== JSON DA REAÇÃO ====="
                );

                console.log(
                    JSON.stringify(

                        registroAtual ||

                        {

                            participantId,

                            name,

                            telefone,

                            emote,

                            resultado,

                            isDeleted,

                            timestamp,

                            total
                        },

                        null,

                        2
                    )
                );

                // =================================================
                // REAÇÕES DO MONGO
                // =================================================

                const reacoesMongo =
                    await buscarReacoes(
                        idMensagemReagida
                    );

                console.log(
                    "\n===== REAÇÕES NO MONGODB ====="
                );

                console.log(
                    JSON.stringify(
                        reacoesMongo,
                        null,
                        2
                    )
                );

                console.log(
                    "\nGrupo:",
                    monitoramento.grupoNome
                );

                console.log(
                    "Total:",
                    total
                );

                console.log(
                    "==============================\n"
                );

            } catch (erro) {

                console.error(
                    "\n❌ ERRO AO PROCESSAR REAÇÃO:"
                );

                console.error(
                    erro
                );
            }
        }
    );
}

// =====================================================
// INICIA MONITORAMENTO DE UMA MENSAGEM
// =====================================================

async function iniciarMonitoramento({

    mensagem,
    grupoId,
    grupoNome

}) {

    const messageId =
        mensagem.id?._serialized ||
        mensagem.id;

    const monitoramento = {

        messageId,

        grupoId,

        grupoNome,

        mensagem,

        inicio:
            new Date(),

        fim:
            new Date(
                Date.now() +
                DURACAO_MONITORAMENTO
            ),

        reacoes:
            new Map(),

        timeout:
            null
    };

    // -------------------------------------------------
    // Salva no mapa
    // -------------------------------------------------

    monitoramentos.set(
        messageId,
        monitoramento
    );

    console.log(
        "\n================================="
    );

    console.log(
        " MONITORAMENTO INICIADO"
    );

    console.log(
        "================================="
    );

    console.log(
        "Mensagem:",
        messageId
    );

    console.log(
        "Grupo:",
        grupoNome
    );

    console.log(
        "Grupo ID:",
        grupoId
    );

    console.log(
        "Duração: 24 horas"
    );

    console.log(
        "Início:",
        monitoramento.inicio.toLocaleString(
            "pt-BR"
        )
    );

    console.log(
        "Fim:",
        monitoramento.fim.toLocaleString(
            "pt-BR"
        )
    );

    // -------------------------------------------------
    // NÃO DELETA REAÇÕES DE OUTRAS MENSAGENS
    // -------------------------------------------------

    await reacoesCollection.deleteMany({

        messageId

    });

    console.log(
        "Banco preparado para o novo monitoramento."
    );

    // -------------------------------------------------
    // ENCERRAMENTO
    // -------------------------------------------------

    monitoramento.timeout =
        setTimeout(

            async () => {

                try {

                    console.log(
                        "\n================================="
                    );

                    console.log(
                        " MONITORAMENTO ENCERRADO"
                    );

                    console.log(
                        "================================="
                    );

                    console.log(
                        "Grupo:",
                        grupoNome
                    );

                    await mostrarReacoes(
                        messageId
                    );

                    monitoramentos.delete(
                        messageId
                    );

                    console.log(
                        `Monitoramento removido: ${grupoNome}`
                    );

                } catch (erro) {

                    console.error(
                        "❌ Erro ao encerrar monitoramento:",
                        erro
                    );
                }

            },

            DURACAO_MONITORAMENTO
        );
}

// =====================================================
// MOSTRA REAÇÕES
// =====================================================

async function mostrarReacoes(
    messageId
) {

    console.log(
        "\n===== REAÇÕES ATUAIS ====="
    );

    const monitoramento =
        monitoramentos.get(
            messageId
        );

    const registros =
        await buscarReacoes(
            messageId
        );

    if (
        registros.length === 0
    ) {

        console.log(
            "Nenhuma reação registrada."
        );

        return;
    }

    console.log(
        "Grupo:",
        monitoramento?.grupoNome ||
        registros[0]?.grupoNome ||
        "Desconhecido"
    );

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

    console.log(
        "==========================\n"
    );
}

// =====================================================
// ENVIA CHECAGEM PARA UM GRUPO
// =====================================================

async function enviarChecagemParaGrupo({

    client,
    grupo

}) {

    console.log(
        "\n================================="
    );

    console.log(
        " PREPARANDO CHECAGEM"
    );

    console.log(
        "================================="
    );

    console.log(
        "Grupo:",
        grupo.name
    );

    const imagem =
        path.join(

            __dirname,

            config.pasta_imagens,

            NOME_IMAGEM
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
                day: "2-digit",
                month: "2-digit",
                year: "numeric"
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

    try {

        console.log(
            "Enviando imagem..."
        );

        const mensagem =
            await client.sendImage(

                grupo.id._serialized,

                imagem,

                NOME_IMAGEM,

                legenda
            );

        if (!mensagem) {

            console.error(
                `❌ WhatsApp não retornou mensagem para ${grupo.name}`
            );

            return;
        }

        const messageId =
            mensagem.id?._serialized ||
            mensagem.id;

        console.log(
            `✅ Checagem enviada para: ${grupo.name}`
        );

        console.log(
            "Mensagem:",
            messageId
        );

        // -------------------------------------------------
        // INICIA MONITORAMENTO
        // -------------------------------------------------

        await iniciarMonitoramento({

            mensagem,

            grupoId:
                grupo.id._serialized,

            grupoNome:
                grupo.name
        });

        // -------------------------------------------------
        // GUARDA ÚLTIMO ENVIO
        // -------------------------------------------------

        ultimosEnvios.set(

            grupo.id._serialized,

            dataAtual()
        );

    } catch (erro) {

        console.error(

            `❌ Erro enviando para ${grupo.name}:`,

            erro
        );
    }
}

// =====================================================
// ENVIA PARA TODOS OS GRUPOS
// =====================================================

async function enviarChecagemParaTodos(
    client
) {

    console.log(
        "\n================================="
    );

    console.log(
        " ENVIANDO CHECAGEM PARA GRUPOS"
    );

    console.log(
        "================================="
    );

    console.log(
        "Quantidade:",
        config.grupos.length
    );

    if (
        config.grupos.length === 0
    ) {

        console.log(
            "⚠️ Nenhum grupo configurado."
        );

        return;
    }

    // -------------------------------------------------
    // Busca grupos do WhatsApp
    // -------------------------------------------------

    const gruposWhatsApp =
        await encontrarGrupos(
            client
        );

    // -------------------------------------------------
    // Envia individualmente
    // -------------------------------------------------

    for (
        const nomeGrupo
        of config.grupos
    ) {

        const grupo =
            gruposWhatsApp.find(

                grupo =>

                    grupo.name
                        ?.trim()
                        .toLowerCase() ===
                    nomeGrupo
                        .trim()
                        .toLowerCase()
            );

        if (!grupo) {

            console.error(
                `❌ Grupo "${nomeGrupo}" não encontrado.`
            );

            continue;
        }

        await enviarChecagemParaGrupo({

            client,

            grupo

        });

        // Pequeno intervalo entre grupos
        await esperar(
            config.intervalo_reacao
        );
    }
}

// =====================================================
// ENCONTRA TODOS OS GRUPOS
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
// CONTROLE DO HORÁRIO
// =====================================================

function dataAtual() {

    const agora =
        new Date();

    return agora
        .toLocaleDateString(
            "pt-BR"
        );
}

// =====================================================
// VERIFICA SE É HORA DE ENVIAR
// =====================================================

function verificarHorarioEnvio(
    client
) {

    const agora =
        new Date();

    const horas =
        String(
            agora.getHours()
        ).padStart(
            2,
            "0"
        );

    const minutos =
        String(
            agora.getMinutes()
        ).padStart(
            2,
            "0"
        );

    const horarioAtual =
        `${horas}:${minutos}`;

    if (
        horarioAtual !==
        config.horario_envio
    ) {

        return;
    }

    const hoje =
        dataAtual();

    for (
        const nomeGrupo
        of config.grupos
    ) {

        // -------------------------------------------------
        // Precisamos descobrir o ID para controlar
        // envio duplicado.
        //
        // Como a função encontra o grupo posteriormente,
        // usamos o nome como chave temporária.
        // -------------------------------------------------

        const chave =
            nomeGrupo
                .trim()
                .toLowerCase();

        const ultimoEnvio =
            ultimosEnvios.get(
                chave
            );

        if (
            ultimoEnvio === hoje
        ) {

            continue;
        }

        // -------------------------------------------------
        // Marca imediatamente para impedir que dois ticks
        // do intervalo iniciem dois envios.
        // -------------------------------------------------

        ultimosEnvios.set(
            chave,
            hoje
        );

        enviarChecagemParaGrupoPorNome(

            client,

            nomeGrupo

        ).catch(
            erro => {

                console.error(
                    `❌ Erro no envio para ${nomeGrupo}:`,
                    erro
                );

                // Permite tentar novamente caso tenha dado erro
                ultimosEnvios.delete(
                    chave
                );
            }
        );
    }
}

// =====================================================
// ENVIA PARA GRUPO PELO NOME
// =====================================================

async function enviarChecagemParaGrupoPorNome(

    client,

    nomeGrupo

) {

    const grupos =
        await encontrarGrupos(
            client
        );

    const alvo =
        nomeGrupo
            .trim()
            .toLowerCase();

    const grupo =
        grupos.find(

            grupo =>

                (
                    grupo.name ||
                    ""
                )
                    .trim()
                    .toLowerCase() ===
                alvo
        );

    if (!grupo) {

        throw new Error(
            `Grupo "${nomeGrupo}" não encontrado.`
        );
    }

    await enviarChecagemParaGrupo({

        client,

        grupo

    });
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

    setInterval(

        () => {

            try {

                verificarHorarioEnvio(
                    client
                );

            } catch (erro) {

                console.error(
                    "❌ Erro no scheduler:",
                    erro
                );
            }

        },

        1000
    );
}

// =====================================================
// AGUARDA WHATSAPP PRONTO
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
                estado === "CONNECTED"
            ) {

                try {

                    const chats =
                        await client.listChats();

                    if (
                        chats &&
                        chats.length > 0
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

    console.log(
        "WhatsApp conectado!"
    );

    // -------------------------------------------------
    // Configuração inicial
    // -------------------------------------------------

    carregarConfig();

    monitorarArquivoConfig();

    // -------------------------------------------------
    // Reações
    // -------------------------------------------------

    configurarMonitoramentoDeReacoes(
        client
    );

    // -------------------------------------------------
    // Aguarda WhatsApp
    // -------------------------------------------------

    await esperarWhatsAppPronto(
        client
    );

    console.log(
        "WhatsApp sincronizado!"
    );

    // -------------------------------------------------
    // Lista grupos configurados
    // -------------------------------------------------

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

    // -------------------------------------------------
    // Scheduler
    // -------------------------------------------------

    iniciarScheduler(
        client
    );
}

// =====================================================
// INICIA BOT
// =====================================================

async function iniciar() {

    try {

        // -------------------------------------------------
        // Config
        // -------------------------------------------------

        carregarConfig();

        // -------------------------------------------------
        // Mongo
        // -------------------------------------------------

        await conectarMongo();

        console.log(
            "\nIniciando WhatsApp..."
        );

        // -------------------------------------------------
        // WhatsApp
        // -------------------------------------------------

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
                    (
                        status
                    ) => {

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
// SLEEP
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

// =====================================================
// START
// =====================================================

iniciar();
