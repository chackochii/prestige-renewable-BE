"use strict";

// A notification raised about a collaboration request names the request, so
// the inbox can open it where it is rather than dropping the reader on the
// job and leaving them to find it. Nullable: most notifications are about the
// record itself. A hard-deleted request leaves its notices in place, unlinked.
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.addColumn("notifications", "request_id", {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: "collaboration_requests", key: "id" },
            onDelete: "SET NULL",
        });
    },

    async down(queryInterface) {
        await queryInterface.removeColumn("notifications", "request_id");
    },
};
